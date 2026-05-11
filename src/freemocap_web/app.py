from __future__ import annotations

import shutil
import sqlite3
import subprocess
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


PACKAGE_DIR = Path(__file__).resolve().parent
STATIC_DIR = PACKAGE_DIR / "static"
VIDEO_SUFFIX = ".mp4"
SYNCHRONIZED_VIDEOS_FOLDER_NAME = "synchronized_videos"
RAW_VIDEOS_FOLDER_NAME = "raw_videos"
BROWSER_PREVIEW_VIDEOS_FOLDER_NAME = "browser_preview_videos"
FREEMOCAP_IMPORT_LOCK = threading.RLock()
SYNC_JOBS: dict[str, dict] = {}
SYNC_JOBS_LOCK = threading.Lock()
DB_LOCK = threading.RLock()
DB_INITIALIZED = False
DEFAULT_PROJECT_ID = "default"
DEFAULT_PROJECT_NAME = "Untitled project"

app = FastAPI(title="FreeMoCap Web", version="0.1.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_path() -> Path:
    data_dir = Path.home() / "freemocap_data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "freemocap_web_state.sqlite"


def _db() -> sqlite3.Connection:
    connection = sqlite3.connect(_db_path())
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


def _init_db() -> None:
    global DB_INITIALIZED
    with DB_LOCK, _db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS shots (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id),
                name TEXT NOT NULL,
                purpose TEXT NOT NULL DEFAULT 'unassigned',
                recording_path TEXT NOT NULL,
                raw_videos_path TEXT NOT NULL,
                synchronized_videos_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                shot_id TEXT NOT NULL REFERENCES shots(id),
                type TEXT NOT NULL,
                state TEXT NOT NULL,
                progress INTEGER NOT NULL,
                message TEXT NOT NULL,
                method TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        connection.execute(
            """
            INSERT OR IGNORE INTO projects (id, name, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, _now(), _now()),
        )
        if not DB_INITIALIZED:
            connection.execute(
                """
                UPDATE jobs
                SET state = 'failed',
                    progress = 100,
                    message = 'Interrupted before completion.',
                    error = 'The server stopped before this job finished.',
                    updated_at = ?
                WHERE state IN ('queued', 'running')
                """,
                (_now(),),
            )
            DB_INITIALIZED = True


def _row_to_dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


def _upsert_shot(
    *,
    shot_id: str,
    name: str,
    purpose: str,
    recording_path: Path,
    raw_videos_path: Path,
    synchronized_videos_path: Path,
) -> dict:
    _init_db()
    timestamp = _now()
    with DB_LOCK, _db() as connection:
        connection.execute(
            """
            INSERT INTO shots (
                id, project_id, name, purpose, recording_path, raw_videos_path,
                synchronized_videos_path, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                purpose = excluded.purpose,
                recording_path = excluded.recording_path,
                raw_videos_path = excluded.raw_videos_path,
                synchronized_videos_path = excluded.synchronized_videos_path,
                updated_at = excluded.updated_at
            """,
            (
                shot_id,
                DEFAULT_PROJECT_ID,
                name,
                purpose,
                str(recording_path),
                str(raw_videos_path),
                str(synchronized_videos_path),
                timestamp,
                timestamp,
            ),
        )
        row = connection.execute("SELECT * FROM shots WHERE id = ?", (shot_id,)).fetchone()
    return dict(row)


def _insert_job(job_id: str, shot_id: str, method: str, message: str) -> dict:
    _init_db()
    timestamp = _now()
    with DB_LOCK, _db() as connection:
        connection.execute(
            """
            INSERT INTO jobs (id, shot_id, type, state, progress, message, method, created_at, updated_at)
            VALUES (?, ?, 'sync', 'queued', 15, ?, ?, ?, ?)
            """,
            (job_id, shot_id, message, method, timestamp, timestamp),
        )
        row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return dict(row)


def _update_job(job_id: str, **updates: object) -> None:
    allowed = {"state", "progress", "message", "error"}
    fields = {key: value for key, value in updates.items() if key in allowed}
    if not fields:
        return
    fields["updated_at"] = _now()
    assignments = ", ".join(f"{key} = ?" for key in fields)
    values = list(fields.values()) + [job_id]
    with DB_LOCK, _db() as connection:
        connection.execute(f"UPDATE jobs SET {assignments} WHERE id = ?", values)


def _get_job_row(job_id: str) -> dict | None:
    _init_db()
    with DB_LOCK, _db() as connection:
        row = connection.execute(
            """
            SELECT jobs.*, shots.name AS recording_name, shots.recording_path
            FROM jobs
            JOIN shots ON shots.id = jobs.shot_id
            WHERE jobs.id = ?
            """,
            (job_id,),
        ).fetchone()
    return _row_to_dict(row)


def _latest_job_for_shot(shot_id: str) -> dict | None:
    with DB_LOCK, _db() as connection:
        row = connection.execute(
            """
            SELECT * FROM jobs
            WHERE shot_id = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (shot_id,),
        ).fetchone()
    return _row_to_dict(row)


def _get_shot(shot_id: str) -> dict:
    _init_db()
    with DB_LOCK, _db() as connection:
        row = connection.execute("SELECT * FROM shots WHERE id = ?", (shot_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Shot not found.")
    return dict(row)


def _get_project() -> dict:
    _init_db()
    with DB_LOCK, _db() as connection:
        row = connection.execute(
            """
            SELECT projects.*,
                (SELECT COUNT(*) FROM shots WHERE shots.project_id = projects.id) AS shot_count
            FROM projects
            WHERE id = ?
            """,
            (DEFAULT_PROJECT_ID,),
        ).fetchone()
    project = dict(row)
    project["is_created"] = project["name"] != DEFAULT_PROJECT_NAME
    return project


def _update_project_name(name: str) -> dict:
    clean = name.strip()
    if not clean:
        raise HTTPException(status_code=400, detail="Project name is required.")
    timestamp = _now()
    _init_db()
    with DB_LOCK, _db() as connection:
        connection.execute(
            "UPDATE projects SET name = ?, updated_at = ? WHERE id = ?",
            (clean[:120], timestamp, DEFAULT_PROJECT_ID),
        )
    return _get_project()


def _safe_recording_name(name: str) -> str:
    clean = "".join(char if char.isalnum() or char in ("-", "_") else "_" for char in name.strip())
    clean = clean.strip("_")
    if not clean:
        raise HTTPException(status_code=400, detail="Recording name is required.")
    return clean[:80]


def _recording_folder(recording_name: str) -> Path:
    return Path(_get_recording_session_folder_path()) / _safe_recording_name(recording_name)


def _get_recording_session_folder_path() -> str:
    with FREEMOCAP_IMPORT_LOCK:
        from freemocap.system.paths_and_filenames.path_getters import get_recording_session_folder_path

    return get_recording_session_folder_path()


def _get_video_paths(video_folder: str | Path) -> list[str]:
    with FREEMOCAP_IMPORT_LOCK:
        from freemocap.utilities.get_video_paths import get_video_paths

    return get_video_paths(video_folder)


def _get_synchronization_functions() -> dict:
    with FREEMOCAP_IMPORT_LOCK:
        try:
            from freemocap.system.paths_and_filenames.path_getters import get_recording_session_folder_path
            from skelly_synchronize import create_audio_debug_plots, create_brightness_debug_plots
            from skelly_synchronize.skelly_synchronize import (
                synchronize_videos_from_audio,
                synchronize_videos_from_brightness,
            )
            get_recording_session_folder_path()
        except Exception as exc:  # pragma: no cover - reported through /api/system.
            return {"error": exc}

    return {
        "create_audio_debug_plots": create_audio_debug_plots,
        "create_brightness_debug_plots": create_brightness_debug_plots,
        "synchronize_videos_from_audio": synchronize_videos_from_audio,
        "synchronize_videos_from_brightness": synchronize_videos_from_brightness,
    }


def _status_for_recording(recording_folder: Path) -> dict:
    with FREEMOCAP_IMPORT_LOCK:
        from freemocap.data_layer.recording_models.recording_info_model import RecordingInfoModel

    info = RecordingInfoModel(recording_folder_path=recording_folder)
    video_paths = _get_video_paths(info.synchronized_videos_folder_path)
    return {
        "name": info.name,
        "path": info.path,
        "synchronized_videos_folder_path": info.synchronized_videos_folder_path,
        "video_count": len(video_paths),
        "videos": [Path(video).name for video in video_paths],
        "status": info.status_check,
    }


def _shot_to_recording(shot: dict) -> dict:
    recording_path = Path(shot["recording_path"])
    try:
        recording = _status_for_recording(recording_path)
    except Exception:
        synchronized_path = Path(shot["synchronized_videos_path"])
        videos = sorted(path.name for path in synchronized_path.glob("*.mp4")) if synchronized_path.exists() else []
        recording = {
            "name": shot["name"],
            "path": str(recording_path),
            "synchronized_videos_folder_path": str(synchronized_path),
            "video_count": len(videos),
            "videos": videos,
            "status": {
                "synchronized_videos_status_check": bool(videos),
                "data2d_status_check": False,
                "data3d_status_check": False,
                "center_of_mass_data_status_check": False,
                "blender_file_status_check": False,
                "single_video_check": len(videos) == 1,
                "calibration_toml_check": False,
            },
        }
    recording["id"] = shot["id"]
    recording["project_id"] = shot["project_id"]
    recording["purpose"] = shot["purpose"]
    recording["created_at"] = shot["created_at"]
    recording["updated_at"] = shot["updated_at"]
    browser_videos_path = Path(shot["synchronized_videos_path"]) / BROWSER_PREVIEW_VIDEOS_FOLDER_NAME
    recording["browser_videos"] = sorted(path.name for path in browser_videos_path.glob("*.mp4")) if browser_videos_path.exists() else []
    preview_assets = list(browser_videos_path.glob("*.mp4")) + list(browser_videos_path.glob("*.jpg")) if browser_videos_path.exists() else []
    recording["browser_preview_updated_at"] = max((path.stat().st_mtime_ns for path in preview_assets), default=None)
    side_by_side_path = browser_videos_path / "side_by_side.mp4"
    recording["side_by_side_video"] = side_by_side_path.name if side_by_side_path.exists() else None
    recording["side_by_side_updated_at"] = side_by_side_path.stat().st_mtime_ns if side_by_side_path.exists() else None
    recording["latest_job"] = _latest_job_for_shot(shot["id"])
    return recording


def _set_job(job_id: str, **updates: object) -> None:
    with SYNC_JOBS_LOCK:
        job = SYNC_JOBS.get(job_id)
        if job is not None:
            job.update(updates)
    _update_job(job_id, **updates)


def _get_job(job_id: str) -> dict:
    job_row = _get_job_row(job_id)
    if job_row is not None:
        job = {
            "id": job_row["id"],
            "shot_id": job_row["shot_id"],
            "state": job_row["state"],
            "progress": job_row["progress"],
            "message": job_row["message"],
            "recording_name": job_row["recording_name"],
            "recording_path": job_row["recording_path"],
            "method": job_row["method"],
            "type": job_row["type"],
            "error": job_row["error"],
            "recording": None,
        }
        with SYNC_JOBS_LOCK:
            memory_job = SYNC_JOBS.get(job_id)
            if memory_job and memory_job.get("recording") is not None:
                job["recording"] = memory_job["recording"]
        return job

    with SYNC_JOBS_LOCK:
        job = SYNC_JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Sync job not found.")
        return dict(job)


def _copy_timestamp_uploads(files: list[UploadFile], destination: Path) -> None:
    timestamp_files = [file for file in files if "timestamps/" in (file.filename or "").replace("\\", "/")]
    if not timestamp_files:
        return

    timestamps_dir = destination / "timestamps"
    timestamps_dir.mkdir(parents=True, exist_ok=True)
    for upload in timestamp_files:
        source_name = Path((upload.filename or "").replace("\\", "/")).name
        if not source_name:
            continue
        upload.file.seek(0)
        with (timestamps_dir / source_name).open("wb") as output:
            shutil.copyfileobj(upload.file, output)


def _save_video_uploads(files: list[UploadFile], destination: Path) -> list[Path]:
    destination.mkdir(parents=True, exist_ok=True)
    saved_paths: list[Path] = []
    for upload in files:
        source_name = Path((upload.filename or "").replace("\\", "/")).name
        if not source_name.lower().endswith(VIDEO_SUFFIX):
            continue

        output_path = destination / source_name
        upload.file.seek(0)
        with output_path.open("wb") as output:
            shutil.copyfileobj(upload.file, output)
        saved_paths.append(output_path)

    if not saved_paths:
        raise HTTPException(status_code=400, detail="No .mp4 files were uploaded.")
    return saved_paths


def _save_sync_video_uploads(files: list[UploadFile], destination: Path) -> list[Path]:
    saved_paths = _save_video_uploads(files, destination)
    if len(saved_paths) < 1:
        shutil.rmtree(destination, ignore_errors=True)
        raise HTTPException(status_code=400, detail="Select one or more .mp4 videos.")
    return saved_paths


def _sync_videos(raw_folder: Path, synchronized_folder: Path, method: str, brightness_threshold: float) -> Path:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise HTTPException(status_code=400, detail="FFmpeg is required for synchronization and was not found.")

    sync = _get_synchronization_functions()
    if "error" in sync:
        raise HTTPException(status_code=500, detail=f"skelly_synchronize is not available: {sync['error']}")

    synchronized_folder.mkdir(parents=True, exist_ok=True)
    if method == "audio":
        output_path = sync["synchronize_videos_from_audio"](
            raw_video_folder_path=raw_folder,
            synchronized_video_folder_path=synchronized_folder,
            create_debug_plots_bool=False,
        )
        return Path(output_path)

    if method == "brightness":
        output_path = sync["synchronize_videos_from_brightness"](
            raw_video_folder_path=raw_folder,
            synchronized_video_folder_path=synchronized_folder,
            brightness_ratio_threshold=brightness_threshold,
            create_debug_plots_bool=False,
        )
        return Path(output_path)

    raise HTTPException(status_code=400, detail="Synchronization method must be 'audio' or 'brightness'.")


def _create_browser_preview_videos(synchronized_folder: Path) -> list[Path]:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise HTTPException(status_code=400, detail="FFmpeg is required for browser previews and was not found.")

    preview_folder = synchronized_folder / BROWSER_PREVIEW_VIDEOS_FOLDER_NAME
    preview_folder.mkdir(parents=True, exist_ok=True)
    preview_paths: list[Path] = []
    source_videos = sorted(
        path for path in synchronized_folder.glob("*.mp4") if path.parent.name != BROWSER_PREVIEW_VIDEOS_FOLDER_NAME
    )

    for source_video in source_videos:
        output_path = preview_folder / source_video.name
        if output_path.exists() and output_path.stat().st_mtime >= source_video.stat().st_mtime:
            _create_browser_preview_poster(output_path)
            preview_paths.append(output_path)
            continue

        temporary_output = output_path.with_name(f"{output_path.stem}.{uuid.uuid4().hex}.tmp.mp4")
        temporary_output.unlink(missing_ok=True)
        command = [
            ffmpeg_path,
            "-y",
            "-i",
            str(source_video),
            "-vf",
            "scale='min(1280,iw)':-2",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-profile:v",
            "baseline",
            "-level",
            "4.0",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "30",
            "-g",
            "30",
            "-bf",
            "0",
            "-video_track_timescale",
            "30000",
            "-movflags",
            "+faststart",
            "-an",
            str(temporary_output),
        ]
        try:
            subprocess.run(command, check=True, capture_output=True, text=True)
            temporary_output.replace(output_path)
        except subprocess.CalledProcessError as exc:
            temporary_output.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Preview encoding failed: {exc.stderr[-1200:]}") from exc
        _create_browser_preview_poster(output_path)
        preview_paths.append(output_path)

    if len(preview_paths) >= 2:
        _create_side_by_side_preview(preview_paths, preview_folder)

    return preview_paths


def _create_side_by_side_preview(preview_paths: list[Path], preview_folder: Path) -> Path:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise HTTPException(status_code=400, detail="FFmpeg is required for side-by-side previews and was not found.")

    output_path = preview_folder / "side_by_side.mp4"
    poster_path = output_path.with_suffix(".jpg")
    newest_input_mtime = max(path.stat().st_mtime for path in preview_paths)
    if output_path.exists() and output_path.stat().st_mtime >= newest_input_mtime:
        _create_browser_preview_poster(output_path)
        return output_path

    temporary_output = output_path.with_name(f"{output_path.stem}.{uuid.uuid4().hex}.tmp.mp4")
    temporary_output.unlink(missing_ok=True)
    input_paths = preview_paths[:4]
    command = [ffmpeg_path, "-y"]
    for input_path in input_paths:
        command.extend(["-i", str(input_path)])

    scaled_streams = "".join(
        f"[{index}:v]fps=30,scale=640:-2,setsar=1,setpts=PTS-STARTPTS[v{index}];"
        for index in range(len(input_paths))
    )
    if len(input_paths) == 2:
        layout_filter = "[v0][v1]hstack=inputs=2:shortest=1[vout]"
    elif len(input_paths) == 3:
        layout_filter = "[v0][v1][v2]hstack=inputs=3:shortest=1[vout]"
    else:
        layout_filter = (
            "[v0][v1]hstack=inputs=2:shortest=1[top];"
            "[v2][v3]hstack=inputs=2:shortest=1[bottom];"
            "[top][bottom]vstack=inputs=2:shortest=1[vout]"
        )

    command.extend(
        [
            "-filter_complex",
            f"{scaled_streams}{layout_filter}",
            "-map",
            "[vout]",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-profile:v",
            "baseline",
            "-level",
            "4.0",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "30",
            "-g",
            "30",
            "-bf",
            "0",
            "-video_track_timescale",
            "30000",
            "-movflags",
            "+faststart",
            "-an",
            str(temporary_output),
        ]
    )
    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
        temporary_output.replace(output_path)
    except subprocess.CalledProcessError as exc:
        temporary_output.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Side-by-side encoding failed: {exc.stderr[-1200:]}") from exc
    _create_browser_preview_poster(output_path)
    return output_path


def _create_browser_preview_poster(preview_video_path: Path) -> Path:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise HTTPException(status_code=400, detail="FFmpeg is required for browser preview posters and was not found.")

    poster_path = preview_video_path.with_suffix(".jpg")
    if poster_path.exists() and poster_path.stat().st_mtime >= preview_video_path.stat().st_mtime:
        return poster_path

    temporary_output = poster_path.with_suffix(".tmp.jpg")
    command = [
        ffmpeg_path,
        "-y",
        "-ss",
        "0.5",
        "-i",
        str(preview_video_path),
        "-frames:v",
        "1",
        "-q:v",
        "3",
        str(temporary_output),
    ]
    subprocess.run(command, check=True, capture_output=True, text=True)
    temporary_output.replace(poster_path)
    return poster_path


def _monitor_sync_outputs(job_id: str, synchronized_folder: Path, expected_video_count: int, stop_event: threading.Event) -> None:
    last_progress = 40
    while not stop_event.wait(2):
        synced_videos = sorted(synchronized_folder.glob("*.mp4"))
        if expected_video_count > 0:
            completed_ratio = min(1.0, len(synced_videos) / expected_video_count)
            progress = max(last_progress, min(82, 45 + round(completed_ratio * 35)))
        else:
            progress = min(82, last_progress + 1)

        if synced_videos:
            message = f"Writing synchronized video {len(synced_videos)} of {expected_video_count}."
        else:
            message = "Extracting timing and preparing synchronized videos."

        if expected_video_count > 0 and len(synced_videos) >= expected_video_count:
            progress = max(progress, 82)
            message = "Finalizing synchronized videos."

        if progress > last_progress:
            _set_job(job_id, progress=progress, message=message)
            last_progress = progress


def _run_sync_job(job_id: str, raw_folder: Path, synchronized_folder: Path, method: str, brightness_threshold: float) -> None:
    try:
        raw_videos = sorted(raw_folder.glob("*.mp4"))
        if len(raw_videos) == 1:
            _set_job(job_id, state="running", progress=35, message="Preparing single-video shot.")
            synchronized_folder.mkdir(parents=True, exist_ok=True)
            shutil.copy(raw_videos[0], synchronized_folder / raw_videos[0].name)
        else:
            _set_job(job_id, state="running", progress=25, message="Loading Skelly synchronization.")
            _set_job(job_id, progress=40, message=f"Running {method} synchronization.")
            stop_monitor = threading.Event()
            monitor = threading.Thread(
                target=_monitor_sync_outputs,
                args=(job_id, synchronized_folder, len(raw_videos), stop_monitor),
                daemon=True,
            )
            monitor.start()
            try:
                _sync_videos(raw_folder, synchronized_folder, method, brightness_threshold)
            finally:
                stop_monitor.set()
                monitor.join(timeout=1)
        _set_job(job_id, progress=85, message="Reading FreeMoCap recording status.")
        recording = _status_for_recording(synchronized_folder.parent)
        _set_job(job_id, progress=90, message="Creating browser preview clips.")
        _create_browser_preview_videos(synchronized_folder)
        _set_job(job_id, state="complete", progress=100, message="Synchronized videos are ready.", recording=recording)
    except Exception as exc:
        _set_job(job_id, state="failed", progress=100, message=str(exc))


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/design-system")
def design_system() -> FileResponse:
    return FileResponse(STATIC_DIR / "design-system.html")


@app.get("/api/system")
def system_info() -> dict:
    _init_db()
    recording_session_folder_path = _get_recording_session_folder_path()
    sync = _get_synchronization_functions()
    return {
        "recording_session_folder_path": recording_session_folder_path,
        "sqlite_state_path": str(_db_path()),
        "ffmpeg_available": shutil.which("ffmpeg") is not None,
        "synchronization_available": "error" not in sync,
        "supported_video_extension": VIDEO_SUFFIX,
    }


@app.get("/api/project")
def get_project() -> dict:
    return {"project": _get_project()}


@app.post("/api/project")
def update_project(name: Annotated[str, Form()]) -> dict:
    return {"project": _update_project_name(name)}


@app.get("/api/recordings")
def list_recordings() -> dict:
    _init_db()
    with DB_LOCK, _db() as connection:
        shot_rows = connection.execute(
            """
            SELECT * FROM shots
            WHERE project_id = ?
            ORDER BY updated_at DESC
            """,
            (DEFAULT_PROJECT_ID,),
        ).fetchall()

    recordings = []
    for shot_row in shot_rows:
        try:
            recordings.append(_shot_to_recording(dict(shot_row)))
        except Exception:
            continue
    return {"recordings": recordings}


@app.post("/api/import-videos")
def import_videos(
    recording_name: Annotated[str, Form()],
    synchronize: Annotated[bool, Form()] = False,
    synchronization_method: Annotated[str, Form()] = "audio",
    brightness_threshold: Annotated[float, Form()] = 1000.0,
    files: Annotated[list[UploadFile], File()] = [],
) -> dict:
    recording_folder = _recording_folder(recording_name)
    synchronized_folder = recording_folder / SYNCHRONIZED_VIDEOS_FOLDER_NAME
    if synchronized_folder.exists() and any(synchronized_folder.iterdir()):
        raise HTTPException(
            status_code=409,
            detail=f"Recording '{recording_folder.name}' already has imported videos. Choose a new recording name.",
        )

    if synchronize:
        raw_tmp = Path(tempfile.mkdtemp(prefix="freemocap-web-upload-"))
        try:
            _save_video_uploads(files, raw_tmp)
            _copy_timestamp_uploads(files, synchronized_folder)
            _sync_videos(raw_tmp, synchronized_folder, synchronization_method, brightness_threshold)
        finally:
            shutil.rmtree(raw_tmp, ignore_errors=True)
    else:
        _save_video_uploads(files, synchronized_folder)
        _copy_timestamp_uploads(files, synchronized_folder)

    return {"recording": _status_for_recording(recording_folder)}


@app.post("/api/sync-jobs")
def create_sync_job(
    recording_name: Annotated[str, Form()],
    purpose: Annotated[str, Form()] = "unassigned",
    synchronization_method: Annotated[str, Form()] = "audio",
    brightness_threshold: Annotated[float, Form()] = 1000.0,
    files: Annotated[list[UploadFile], File()] = [],
) -> dict:
    if purpose not in {"calibration", "motion_capture", "unassigned"}:
        raise HTTPException(status_code=400, detail="Purpose must be calibration, motion_capture, or unassigned.")

    recording_folder = _recording_folder(recording_name)
    raw_folder = recording_folder / RAW_VIDEOS_FOLDER_NAME
    synchronized_folder = recording_folder / SYNCHRONIZED_VIDEOS_FOLDER_NAME

    if synchronized_folder.exists() and any(synchronized_folder.iterdir()):
        raise HTTPException(
            status_code=409,
            detail=f"Recording '{recording_folder.name}' already has synchronized videos. Choose a new recording name.",
        )

    if raw_folder.exists():
        shutil.rmtree(raw_folder)
    raw_folder.mkdir(parents=True, exist_ok=True)
    saved_paths = _save_sync_video_uploads(files, raw_folder)

    job_id = uuid.uuid4().hex
    shot_id = uuid.uuid4().hex
    shot = _upsert_shot(
        shot_id=shot_id,
        name=recording_folder.name,
        purpose=purpose,
        recording_path=recording_folder,
        raw_videos_path=raw_folder,
        synchronized_videos_path=synchronized_folder,
    )
    _insert_job(job_id, shot["id"], synchronization_method, f"Uploaded {len(saved_paths)} videos.")
    with SYNC_JOBS_LOCK:
        SYNC_JOBS[job_id] = {
            "id": job_id,
            "state": "queued",
            "progress": 15,
            "message": f"Uploaded {len(saved_paths)} videos.",
            "shot_id": shot["id"],
            "recording_name": recording_folder.name,
            "recording_path": str(recording_folder),
            "raw_videos": [path.name for path in saved_paths],
            "recording": None,
        }

    worker = threading.Thread(
        target=_run_sync_job,
        args=(job_id, raw_folder, synchronized_folder, synchronization_method, brightness_threshold),
        daemon=True,
    )
    worker.start()
    return {"job": _get_job(job_id)}


@app.get("/api/sync-jobs/{job_id}")
def get_sync_job(job_id: str) -> dict:
    return {"job": _get_job(job_id)}


@app.post("/api/shots/{shot_id}/browser-previews")
def create_browser_previews(shot_id: str) -> dict:
    shot = _get_shot(shot_id)
    synchronized_folder = Path(shot["synchronized_videos_path"])
    if not synchronized_folder.exists():
        raise HTTPException(status_code=404, detail="Synchronized videos folder not found.")
    preview_paths = _create_browser_preview_videos(synchronized_folder)
    return {"browser_videos": [path.name for path in preview_paths]}


@app.get("/api/shots/{shot_id}/videos/{filename}")
def get_synchronized_video(shot_id: str, filename: str) -> FileResponse:
    if Path(filename).name != filename or not filename.lower().endswith(VIDEO_SUFFIX):
        raise HTTPException(status_code=400, detail="Invalid video filename.")

    shot = _get_shot(shot_id)
    synchronized_folder = Path(shot["synchronized_videos_path"]).resolve()
    preview_folder = (synchronized_folder / BROWSER_PREVIEW_VIDEOS_FOLDER_NAME).resolve()
    video_path = (preview_folder / filename).resolve()
    if preview_folder not in video_path.parents or not video_path.exists():
        raise HTTPException(status_code=404, detail="Video not found.")

    return FileResponse(
        video_path,
        media_type="video/mp4",
        filename=filename,
        content_disposition_type="inline",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/shots/{shot_id}/posters/{filename}")
def get_synchronized_video_poster(shot_id: str, filename: str) -> FileResponse:
    if Path(filename).name != filename or not filename.lower().endswith(".jpg"):
        raise HTTPException(status_code=400, detail="Invalid poster filename.")

    shot = _get_shot(shot_id)
    synchronized_folder = Path(shot["synchronized_videos_path"]).resolve()
    preview_folder = (synchronized_folder / BROWSER_PREVIEW_VIDEOS_FOLDER_NAME).resolve()
    poster_path = (preview_folder / filename).resolve()
    if preview_folder not in poster_path.parents or not poster_path.exists():
        raise HTTPException(status_code=404, detail="Poster not found.")

    return FileResponse(
        poster_path,
        media_type="image/jpeg",
        filename=filename,
        content_disposition_type="inline",
        headers={"Cache-Control": "no-store"},
    )


def main() -> None:
    import uvicorn

    uvicorn.run("freemocap_web.app:app", host="127.0.0.1", port=8000)
