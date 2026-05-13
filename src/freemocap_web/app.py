from __future__ import annotations

import shutil
import sqlite3
import subprocess
import tempfile
import threading
import json
import math
import tomllib
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles


PACKAGE_DIR = Path(__file__).resolve().parent
STATIC_DIR = PACKAGE_DIR / "static"
VIDEO_SUFFIX = ".mp4"
SYNCHRONIZED_VIDEOS_FOLDER_NAME = "synchronized_videos"
RAW_VIDEOS_FOLDER_NAME = "raw_videos"
BROWSER_PREVIEW_VIDEOS_FOLDER_NAME = "browser_preview_videos"
BROWSER_PREVIEW_ENCODER_VERSION = "browser-preview-v3-h264-baseline-side-by-side"
CALIBRATION_PREVIEW_VIDEOS_FOLDER_NAME = "calibration_preview_videos"
CALIBRATION_PREVIEW_ENCODER_VERSION = "calibration-preview-v4-selected-ground-frame"
ANNOTATED_VIDEOS_FOLDER_NAME = "annotated_videos"
FREEMOCAP_IMPORT_LOCK = threading.RLock()
SYNC_JOBS: dict[str, dict] = {}
SYNC_JOBS_LOCK = threading.Lock()
DB_LOCK = threading.RLock()
DB_INITIALIZED = False
STATE_DB_EXISTED_AT_START: bool | None = None
FRAME_PREVIEW_EXTRACT_SEMAPHORE = threading.BoundedSemaphore(2)
FRAME_PREVIEW_LOCKS: dict[str, threading.Lock] = {}
FRAME_PREVIEW_LOCKS_LOCK = threading.Lock()
FRAME_PREVIEW_LATEST_REQUESTS: dict[tuple[str, str], int] = {}
FRAME_PREVIEW_LATEST_REQUESTS_LOCK = threading.Lock()
VIDEO_FPS_CACHE: dict[tuple[str, int, int], float] = {}
VIDEO_FPS_CACHE_LOCK = threading.Lock()
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
    global DB_INITIALIZED, STATE_DB_EXISTED_AT_START
    if STATE_DB_EXISTED_AT_START is None:
        STATE_DB_EXISTED_AT_START = _db_path().exists()
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


def _insert_job(
    job_id: str,
    shot_id: str,
    *,
    job_type: str,
    method: str,
    message: str,
    progress: int = 15,
) -> dict:
    _init_db()
    timestamp = _now()
    with DB_LOCK, _db() as connection:
        connection.execute(
            """
            INSERT INTO jobs (id, shot_id, type, state, progress, message, method, created_at, updated_at)
            VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)
            """,
            (job_id, shot_id, job_type, progress, message, method, timestamp, timestamp),
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


def _invalidate_downstream_jobs(shot_id: str) -> None:
    timestamp = _now()
    with DB_LOCK, _db() as connection:
        connection.execute(
            """
            UPDATE jobs
            SET state = 'invalidated',
                progress = 0,
                message = 'Reset after manual video resync.',
                error = NULL,
                updated_at = ?
            WHERE shot_id = ?
                AND type IN ('calibration', 'motion_capture')
                AND state IN ('queued', 'running', 'complete', 'failed')
            """,
            (timestamp, shot_id),
        )


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


def _latest_job_for_shot_type(shot_id: str, job_type: str) -> dict | None:
    with DB_LOCK, _db() as connection:
        row = connection.execute(
            """
            SELECT * FROM jobs
            WHERE shot_id = ? AND type = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (shot_id, job_type),
        ).fetchone()
    return _row_to_dict(row)


def _get_shot(shot_id: str) -> dict:
    _init_db()
    with DB_LOCK, _db() as connection:
        row = connection.execute("SELECT * FROM shots WHERE id = ?", (shot_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Shot not found.")
    return dict(row)


def _delete_shot(shot_id: str, *, force: bool = False) -> dict:
    if not force:
        raise HTTPException(status_code=400, detail="Set force=true to delete a shot.")

    shot = _get_shot(shot_id)
    recording_path = Path(shot["recording_path"])

    with SYNC_JOBS_LOCK:
        for job_id, job in list(SYNC_JOBS.items()):
            if job.get("shot_id") == shot_id:
                SYNC_JOBS.pop(job_id, None)

    with DB_LOCK, _db() as connection:
        connection.execute("DELETE FROM jobs WHERE shot_id = ?", (shot_id,))
        connection.execute("DELETE FROM shots WHERE id = ?", (shot_id,))

    if recording_path.exists():
        shutil.rmtree(recording_path)

    return {"id": shot_id, "name": shot["name"], "recording_path": str(recording_path)}


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
    project["is_created"] = (
        project["name"] != DEFAULT_PROJECT_NAME
        or int(project.get("shot_count") or 0) > 0
        or bool(STATE_DB_EXISTED_AT_START)
    )
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


def _mp4_paths(folder: Path) -> list[Path]:
    if not folder.exists():
        return []
    return sorted(path for path in folder.iterdir() if path.is_file() and path.suffix.lower() == VIDEO_SUFFIX)


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


def _get_calibration_functions() -> dict:
    with FREEMOCAP_IMPORT_LOCK:
        try:
            from freemocap.core_processes.capture_volume_calibration.charuco_stuff.charuco_board_definition import (
                CHARUCO_BOARDS,
            )
            from freemocap.core_processes.capture_volume_calibration.run_anipose_capture_volume_calibration import (
                run_anipose_capture_volume_calibration,
            )
        except Exception as exc:  # pragma: no cover - reported through /api/system.
            return {"error": exc}

    return {
        "CHARUCO_BOARDS": CHARUCO_BOARDS,
        "run_anipose_capture_volume_calibration": run_anipose_capture_volume_calibration,
    }


def _get_motion_capture_functions() -> dict:
    with FREEMOCAP_IMPORT_LOCK:
        try:
            from freemocap.core_processes.process_motion_capture_videos.process_recording_headless import (
                process_recording_headless,
            )
            from freemocap.data_layer.recording_models.post_processing_parameter_models import ProcessingParameterModel
        except Exception as exc:  # pragma: no cover - reported through /api/system.
            return {"error": exc}

    return {
        "process_recording_headless": process_recording_headless,
        "ProcessingParameterModel": ProcessingParameterModel,
    }


def _status_for_recording(recording_folder: Path) -> dict:
    with FREEMOCAP_IMPORT_LOCK:
        from freemocap.data_layer.recording_models.recording_info_model import RecordingInfoModel

    info = RecordingInfoModel(recording_folder_path=recording_folder)
    video_paths = _get_video_paths(info.synchronized_videos_folder_path)
    if not video_paths:
        video_paths = [str(path) for path in _mp4_paths(Path(info.synchronized_videos_folder_path))]
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
    synchronized_path = Path(shot["synchronized_videos_path"])
    raw_videos_path = Path(shot["raw_videos_path"])
    latest_job = _latest_job_for_shot(shot["id"])
    if not _mp4_paths(synchronized_path) and _mp4_paths(raw_videos_path):
        if latest_job and latest_job["type"] == "sync" and latest_job["state"] == "complete" and latest_job["method"] == "manual":
            _copy_videos_with_ffmpeg(raw_videos_path, synchronized_path)

    try:
        recording = _status_for_recording(recording_path)
    except Exception:
        videos = [path.name for path in _mp4_paths(synchronized_path)]
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
    synchronized_videos = _mp4_paths(synchronized_path)
    recording["synchronized_video_frame_counts"] = {
        path.name: _probe_video_frame_count(path) for path in synchronized_videos
    }
    recording["synchronized_video_fps"] = {
        path.name: _cached_video_fps(path) for path in synchronized_videos
    }
    recording["raw_videos"] = [path.name for path in _mp4_paths(raw_videos_path)]
    browser_videos_path = Path(shot["synchronized_videos_path"]) / BROWSER_PREVIEW_VIDEOS_FOLDER_NAME
    recording["browser_videos"] = (
        sorted(path.name for path in _mp4_paths(browser_videos_path) if not path.name.endswith(".tmp.mp4"))
        if browser_videos_path.exists()
        else []
    )
    if not recording["browser_videos"] and recording.get("videos"):
        recording["browser_videos"] = list(recording["videos"])
    preview_assets = _mp4_paths(browser_videos_path) + list(browser_videos_path.glob("*.jpg")) if browser_videos_path.exists() else []
    recording["browser_preview_updated_at"] = max((path.stat().st_mtime_ns for path in preview_assets), default=None)
    preview_version_path = browser_videos_path / ".preview-version"
    recording["browser_preview_ready"] = (
        preview_version_path.exists() and preview_version_path.read_text().strip() == BROWSER_PREVIEW_ENCODER_VERSION
    )
    side_by_side_path = browser_videos_path / "side_by_side.mp4"
    recording["side_by_side_video"] = side_by_side_path.name if side_by_side_path.exists() else None
    recording["side_by_side_updated_at"] = side_by_side_path.stat().st_mtime_ns if side_by_side_path.exists() else None
    calibration_preview_path = Path(shot["synchronized_videos_path"]) / CALIBRATION_PREVIEW_VIDEOS_FOLDER_NAME
    calibration_preview_version_path = calibration_preview_path / ".preview-version"
    calibration_preview_assets = (
        _mp4_paths(calibration_preview_path) + list(calibration_preview_path.glob("*.jpg"))
        if calibration_preview_path.exists()
        else []
    )
    calibration_side_by_side_path = calibration_preview_path / "side_by_side.mp4"
    recording["calibration_preview_videos"] = (
        [path.name for path in _mp4_paths(calibration_preview_path)] if calibration_preview_path.exists() else []
    )
    calibration_debug_frames_path = calibration_preview_path / "debug_frames"
    recording["calibration_debug_frames"] = (
        sorted(path.name for path in calibration_debug_frames_path.glob("*.jpg"))
        if calibration_debug_frames_path.exists()
        else []
    )
    recording["calibration_preview_ready"] = (
        calibration_preview_version_path.exists()
        and calibration_preview_version_path.read_text().strip() == CALIBRATION_PREVIEW_ENCODER_VERSION
        and calibration_side_by_side_path.exists()
    )
    recording["calibration_preview_updated_at"] = max(
        (path.stat().st_mtime_ns for path in calibration_preview_assets),
        default=None,
    )
    recording["calibration_side_by_side_video"] = (
        calibration_side_by_side_path.name if calibration_side_by_side_path.exists() else None
    )
    calibration_toml_path = _get_calibration_toml_path(recording_path)
    recording["calibration_toml_path"] = str(calibration_toml_path) if calibration_toml_path else None
    recording["calibration_toml_name"] = calibration_toml_path.name if calibration_toml_path else None
    recording["calibration_artifact"] = _calibration_artifact_from_toml(calibration_toml_path)
    recording["motion_capture_artifact"] = _motion_capture_artifact(recording_path)
    latest_sync_job = _latest_job_for_shot_type(shot["id"], "sync")
    recording["sync_method"] = latest_sync_job.get("method") if latest_sync_job else None
    annotated_videos_path = recording_path / ANNOTATED_VIDEOS_FOLDER_NAME
    annotated_assets = (
        _mp4_paths(annotated_videos_path) + list(annotated_videos_path.glob("*.jpg"))
        if annotated_videos_path.exists()
        else []
    )
    pose_side_by_side_path = annotated_videos_path / "side_by_side.mp4"
    recording["pose_preview_videos"] = (
        [path.name for path in _mp4_paths(annotated_videos_path)] if annotated_videos_path.exists() else []
    )
    recording["pose_preview_posters"] = (
        sorted(path.name for path in annotated_videos_path.glob("*.jpg")) if annotated_videos_path.exists() else []
    )
    recording["pose_preview_ready"] = pose_side_by_side_path.exists()
    recording["pose_side_by_side_video"] = pose_side_by_side_path.name if pose_side_by_side_path.exists() else None
    recording["pose_preview_updated_at"] = max((path.stat().st_mtime_ns for path in annotated_assets), default=None)
    recording["status"]["calibration_toml_check"] = bool(
        recording["status"].get("calibration_toml_check") or calibration_toml_path
    )
    if (
        latest_job
        and latest_job.get("type") == "calibration"
        and calibration_toml_path is not None
        and latest_job.get("state") in {"complete", "failed"}
    ):
        latest_job = {
            **latest_job,
            "state": "complete",
            "progress": 100,
            "message": f"Calibration saved: {calibration_toml_path.name}.",
            "error": None,
        }
    if (
        latest_job
        and latest_job.get("type") == "motion_capture"
        and recording["motion_capture_artifact"].get("data3d")
        and latest_job.get("state") in {"complete", "failed"}
    ):
        latest_job = {
            **latest_job,
            "state": "complete",
            "progress": 100,
            "message": "Pose estimation outputs saved.",
            "error": None,
        }
    recording["latest_job"] = latest_job
    return recording


def _get_calibration_toml_path(recording_folder: Path) -> Path | None:
    toml_paths = sorted(recording_folder.glob("*.toml"), key=lambda path: path.stat().st_mtime, reverse=True)
    return toml_paths[0] if toml_paths else None


def _camera_center_from_extrinsics(camera_data: dict) -> list[float] | None:
    try:
        import cv2
        import numpy as np

        rotation = np.asarray(camera_data.get("rotation", [0, 0, 0]), dtype="float64").reshape(3, 1)
        translation = np.asarray(camera_data.get("translation", [0, 0, 0]), dtype="float64").reshape(3, 1)
        rotation_matrix, _ = cv2.Rodrigues(rotation)
        camera_center = -rotation_matrix.T @ translation
        return [float(value) for value in camera_center.reshape(3)]
    except Exception:
        return None


def _calibration_artifact_from_toml(calibration_toml_path: Path | None) -> dict | None:
    if calibration_toml_path is None or not calibration_toml_path.exists():
        return None

    try:
        calibration_data = tomllib.loads(calibration_toml_path.read_text())
    except Exception:
        return None

    metadata = calibration_data.get("metadata") if isinstance(calibration_data.get("metadata"), dict) else {}
    cameras: list[dict] = []
    position_source = "world_position"
    for key, value in calibration_data.items():
        if not isinstance(value, dict) or "matrix" not in value:
            continue
        camera_center = _camera_center_from_extrinsics(value)
        world_position = value.get("world_position")
        if world_position is None:
            world_position = camera_center or [0, 0, 0]
            position_source = "extrinsic_camera_center"
        cameras.append(
            {
                "id": key,
                "name": value.get("name") or key,
                "world_position": world_position,
                "camera_center": camera_center,
                "image_size": value.get("size"),
            }
        )

    return {
        "toml_name": calibration_toml_path.name,
        "toml_path": str(calibration_toml_path),
        "camera_count": len(cameras),
        "cameras": cameras,
        "position_source": position_source,
        "date_time_calibrated": metadata.get("date_time_calibrated"),
        "charuco_square_size": metadata.get("charuco_square_size"),
        "charuco_board": metadata.get("charuco_board_object"),
        "groundplane_calibration": bool(metadata.get("groundplane_calibration")),
        "path_to_recorded_videos": metadata.get("path_to_recorded_videos"),
    }


def _artifact_file(path: Path, recording_folder: Path) -> dict:
    return {
        "name": path.name,
        "path": str(path),
        "relative_path": str(path.relative_to(recording_folder)),
        "size_bytes": path.stat().st_size if path.exists() else 0,
    }


def _motion_capture_artifact(recording_folder: Path) -> dict:
    output_folder = recording_folder / "output_data"
    raw_folder = output_folder / "raw_data"
    center_of_mass_folder = output_folder / "center_of_mass"
    def motion_files(paths):
        return sorted(path for path in paths if "charuco" not in path.name.lower())

    candidates = {
        "data2d": motion_files(raw_folder.glob("*2dData_numCams_numFrames_numTrackedPoints_pixelXY.npy")),
        "raw3d": motion_files(raw_folder.glob("*3dData_numFrames_numTrackedPoints_spatialXYZ.npy")),
        "reprojection_error": motion_files(raw_folder.glob("*reprojectionError.npy")),
        "data3d": motion_files(output_folder.glob("*skeleton_3d.npy")) + motion_files(output_folder.glob("*Skel_3d*.npy")),
        "body_csv": motion_files(output_folder.glob("*body_3d_xyz.csv")),
        "center_of_mass": motion_files(center_of_mass_folder.glob("*total_body_center_of_mass_xyz.npy")),
    }
    files = {
        key: _artifact_file(paths[0], recording_folder) if paths else None
        for key, paths in candidates.items()
    }
    files["all_output_files"] = [
        _artifact_file(path, recording_folder)
        for path in sorted(output_folder.rglob("*"))
        if path.is_file() and path.suffix.lower() in {".npy", ".csv", ".json"} and "charuco" not in path.name.lower()
    ] if output_folder.exists() else []
    return files


def _pose_3d_body_path(recording_folder: Path) -> Path | None:
    output_folder = recording_folder / "output_data"
    candidates = sorted(output_folder.glob("*body_3d_xyz.npy"))
    candidates = [path for path in candidates if "charuco" not in path.name.lower()]
    if candidates:
        return candidates[0]
    skeleton_candidates = sorted(output_folder.glob("*skeleton_3d.npy"))
    skeleton_candidates = [path for path in skeleton_candidates if "charuco" not in path.name.lower()]
    return skeleton_candidates[0] if skeleton_candidates else None


def _pose_3d_marker_names(recording_folder: Path, marker_count: int) -> list[str]:
    body_csv_candidates = sorted((recording_folder / "output_data").glob("*body_3d_xyz.csv"))
    body_csv_candidates = [path for path in body_csv_candidates if "charuco" not in path.name.lower()]
    if body_csv_candidates:
        header = body_csv_candidates[0].read_text(errors="ignore").splitlines()[0]
        columns = [column.strip() for column in header.split(",") if column.strip()]
        names = []
        for column in columns[::3]:
            if column.endswith("_x"):
                column = column[:-2]
            names.append(column.removeprefix("body_"))
        if len(names) >= marker_count:
            return names[:marker_count]
    return [f"point_{index + 1}" for index in range(marker_count)]


def _pose_3d_fps(recording_folder: Path) -> float:
    parameters_path = recording_folder / "output_data" / "recording_parameters.json"
    if not parameters_path.exists():
        return 30.0
    try:
        parameters = json.loads(parameters_path.read_text())
        framerate = parameters.get("post_processing_parameters_model", {}).get("framerate")
        return float(framerate) if framerate else 30.0
    except (OSError, ValueError, TypeError):
        return 30.0


def _calibration_preview_cache_key(shot: dict) -> int:
    preview_folder = Path(shot["synchronized_videos_path"]) / CALIBRATION_PREVIEW_VIDEOS_FOLDER_NAME
    assets = _mp4_paths(preview_folder) + list(preview_folder.glob("*.jpg")) if preview_folder.exists() else []
    return max((path.stat().st_mtime_ns for path in assets), default=0)


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
            raise HTTPException(status_code=404, detail="Job not found.")
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


def _unique_destination_path(destination: Path, source_name: str) -> Path:
    candidate = destination / Path(source_name).name
    if not candidate.exists():
        return candidate

    stem = candidate.stem
    suffix = candidate.suffix
    index = 2
    while True:
        next_candidate = destination / f"{stem}_{index}{suffix}"
        if not next_candidate.exists():
            return next_candidate
        index += 1


def _save_video_uploads(files: list[UploadFile], destination: Path) -> list[Path]:
    destination.mkdir(parents=True, exist_ok=True)
    saved_paths: list[Path] = []
    for upload in files:
        source_name = Path((upload.filename or "").replace("\\", "/")).name
        if not source_name.lower().endswith(VIDEO_SUFFIX):
            continue

        output_path = _unique_destination_path(destination, source_name)
        upload.file.seek(0)
        with output_path.open("wb") as output:
            shutil.copyfileobj(upload.file, output)
        saved_paths.append(output_path)

    if not saved_paths:
        raise HTTPException(status_code=400, detail="No .mp4 files were uploaded.")
    return saved_paths


def _parse_local_video_paths(local_video_paths: str | None) -> list[Path]:
    if not local_video_paths:
        return []
    paths = []
    for line in local_video_paths.splitlines():
        raw_path = line.strip().strip("\"'")
        if raw_path:
            paths.append(Path(raw_path).expanduser())
    return paths


def _copy_local_video_paths(local_video_paths: str | None, destination: Path) -> list[Path]:
    destination.mkdir(parents=True, exist_ok=True)
    saved_paths: list[Path] = []
    for source_path in _parse_local_video_paths(local_video_paths):
        if not source_path.is_file():
            raise HTTPException(status_code=400, detail=f"Local video path does not exist: {source_path}")
        if source_path.suffix.lower() != VIDEO_SUFFIX:
            raise HTTPException(status_code=400, detail=f"Local video path is not an .mp4 file: {source_path}")

        output_path = _unique_destination_path(destination, source_path.name)
        shutil.copy2(source_path, output_path)
        saved_paths.append(output_path)
    return saved_paths


def _save_sync_video_sources(files: list[UploadFile], local_video_paths: str | None, destination: Path) -> list[Path]:
    saved_paths: list[Path] = []
    try:
        saved_paths.extend(_copy_local_video_paths(local_video_paths, destination))
        upload_files = [file for file in files if file.filename]
        if upload_files:
            saved_paths.extend(_save_video_uploads(upload_files, destination))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if len(saved_paths) < 1:
        shutil.rmtree(destination, ignore_errors=True)
        raise HTTPException(status_code=400, detail="Select one or more .mp4 videos or paste local video paths.")
    return saved_paths


def _copy_videos_with_ffmpeg(source_folder: Path, destination_folder: Path) -> list[Path]:
    destination_folder.mkdir(parents=True, exist_ok=True)
    output_paths: list[Path] = []
    source_videos = _mp4_paths(source_folder)
    if not source_videos:
        raise HTTPException(status_code=400, detail="No .mp4 videos were found for manual synchronization.")

    ffmpeg_path = shutil.which("ffmpeg")
    for source_video in source_videos:
        output_path = destination_folder / source_video.name
        if ffmpeg_path is None:
            shutil.copy2(source_video, output_path)
            output_paths.append(output_path)
            continue

        command = [
            ffmpeg_path,
            "-y",
            "-i",
            str(source_video),
            "-map",
            "0:v:0",
            "-c:v",
            "copy",
            "-an",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        try:
            subprocess.run(command, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as exc:
            raise HTTPException(status_code=500, detail=f"Manual sync copy failed: {exc.stderr[-1200:]}") from exc
        output_paths.append(output_path)
    return output_paths


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

    raise HTTPException(status_code=400, detail="Synchronization method must be 'audio', 'brightness', or 'manual'.")


def _create_browser_preview_videos(synchronized_folder: Path, force: bool = False, preset: str = "veryfast") -> list[Path]:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise HTTPException(status_code=400, detail="FFmpeg is required for browser previews and was not found.")

    preview_folder = synchronized_folder / BROWSER_PREVIEW_VIDEOS_FOLDER_NAME
    preview_folder.mkdir(parents=True, exist_ok=True)
    preview_version_path = preview_folder / ".preview-version"
    if preview_version_path.exists() and preview_version_path.read_text().strip() != BROWSER_PREVIEW_ENCODER_VERSION:
        force = True
    elif not preview_version_path.exists():
        force = True

    preview_paths: list[Path] = []
    source_videos = _mp4_paths(synchronized_folder)

    for source_video in source_videos:
        output_path = preview_folder / source_video.name
        if not force and output_path.exists() and output_path.stat().st_mtime >= source_video.stat().st_mtime:
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
            preset,
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
        _create_side_by_side_preview(preview_paths, preview_folder, force=force, preset=preset)

    preview_version_path.write_text(BROWSER_PREVIEW_ENCODER_VERSION)

    return preview_paths


def _create_side_by_side_preview(
    preview_paths: list[Path],
    preview_folder: Path,
    force: bool = False,
    *,
    preset: str = "veryfast",
    tile_width: int = 640,
    crf: int = 23,
    profile: str = "baseline",
    level: str = "4.0",
) -> Path:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise HTTPException(status_code=400, detail="FFmpeg is required for side-by-side previews and was not found.")

    output_path = preview_folder / "side_by_side.mp4"
    newest_input_mtime = max(path.stat().st_mtime for path in preview_paths)
    if not force and output_path.exists() and output_path.stat().st_mtime >= newest_input_mtime:
        _create_browser_preview_poster(output_path)
        return output_path

    temporary_output = output_path.with_name(f"{output_path.stem}.{uuid.uuid4().hex}.tmp.mp4")
    temporary_output.unlink(missing_ok=True)
    input_paths = preview_paths[:4]
    command = [ffmpeg_path, "-y"]
    for input_path in input_paths:
        command.extend(["-i", str(input_path)])

    scaled_streams = "".join(
        f"[{index}:v]fps=30,scale={tile_width}:-2,setsar=1,setpts=PTS-STARTPTS[v{index}];"
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
            preset,
            "-crf",
            str(crf),
            "-profile:v",
            profile,
            "-level",
            level,
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


def _clear_downstream_artifacts(recording_folder: Path) -> None:
    for folder_name in ["output_data", ANNOTATED_VIDEOS_FOLDER_NAME]:
        shutil.rmtree(recording_folder / folder_name, ignore_errors=True)

    synchronized_folder = recording_folder / SYNCHRONIZED_VIDEOS_FOLDER_NAME
    for folder_name in [BROWSER_PREVIEW_VIDEOS_FOLDER_NAME, CALIBRATION_PREVIEW_VIDEOS_FOLDER_NAME, "frame_preview_images"]:
        shutil.rmtree(synchronized_folder / folder_name, ignore_errors=True)

    for toml_path in recording_folder.glob("*.toml"):
        toml_path.unlink(missing_ok=True)


def _probe_video_frame_count(video_path: Path) -> int:
    ffprobe_path = shutil.which("ffprobe")
    if ffprobe_path is None:
        raise HTTPException(status_code=400, detail="FFprobe is required for manual resync and was not found.")

    command = [
        ffprobe_path,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=nb_frames,duration,avg_frame_rate",
        "-of",
        "default=noprint_wrappers=1",
        str(video_path),
    ]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    values = {}
    for line in result.stdout.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value

    if values.get("nb_frames", "").isdigit():
        return int(values["nb_frames"])

    duration = float(values.get("duration") or 0)
    rate = values.get("avg_frame_rate") or "30/1"
    numerator, _, denominator = rate.partition("/")
    fps = float(numerator or 30) / float(denominator or 1)
    return max(0, round(duration * fps))


def _probe_video_fps(video_path: Path) -> float:
    ffprobe_path = shutil.which("ffprobe")
    if ffprobe_path is None:
        return 30.0

    command = [
        ffprobe_path,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=avg_frame_rate,r_frame_rate",
        "-of",
        "default=noprint_wrappers=1",
        str(video_path),
    ]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError:
        return 30.0

    values = {}
    for line in result.stdout.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    rate = values.get("avg_frame_rate") or values.get("r_frame_rate") or "30/1"
    numerator, _, denominator = rate.partition("/")
    try:
        return max(1.0, float(numerator or 30) / float(denominator or 1))
    except (TypeError, ValueError, ZeroDivisionError):
        return 30.0


def _cached_video_fps(video_path: Path) -> float:
    stat = video_path.stat()
    cache_key = (str(video_path), stat.st_mtime_ns, stat.st_size)
    with VIDEO_FPS_CACHE_LOCK:
        cached_fps = VIDEO_FPS_CACHE.get(cache_key)
    if cached_fps is not None:
        return cached_fps

    with FRAME_PREVIEW_EXTRACT_SEMAPHORE:
        fps = _probe_video_fps(video_path)
    with VIDEO_FPS_CACHE_LOCK:
        if len(VIDEO_FPS_CACHE) > 128:
            VIDEO_FPS_CACHE.clear()
        VIDEO_FPS_CACHE[cache_key] = fps
    return fps


def _synchronized_video_path(shot: dict, filename: str) -> Path:
    if Path(filename).name != filename or not filename.lower().endswith(VIDEO_SUFFIX):
        raise HTTPException(status_code=400, detail="Invalid video filename.")

    synchronized_folder = Path(shot["synchronized_videos_path"]).resolve()
    video_path = (synchronized_folder / filename).resolve()
    if synchronized_folder not in video_path.parents or not video_path.exists():
        raise HTTPException(status_code=404, detail="Video not found.")
    return video_path


def _frame_preview_lock(output_path: Path) -> threading.Lock:
    key = str(output_path)
    with FRAME_PREVIEW_LOCKS_LOCK:
        lock = FRAME_PREVIEW_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            FRAME_PREVIEW_LOCKS[key] = lock
        return lock


def _set_latest_frame_preview_request(shot_id: str, filename: str, request_id: int) -> tuple[str, str]:
    key = (shot_id, filename)
    with FRAME_PREVIEW_LATEST_REQUESTS_LOCK:
        FRAME_PREVIEW_LATEST_REQUESTS[key] = max(request_id, FRAME_PREVIEW_LATEST_REQUESTS.get(key, 0))
    return key


def _is_stale_frame_preview_request(key: tuple[str, str], request_id: int) -> bool:
    if request_id <= 0:
        return False
    with FRAME_PREVIEW_LATEST_REQUESTS_LOCK:
        return request_id < FRAME_PREVIEW_LATEST_REQUESTS.get(key, 0)


def _extract_video_frame(video_path: Path, output_path: Path, frame: int, fps: float = 30.0) -> Path:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise HTTPException(status_code=400, detail="FFmpeg is required for frame previews and was not found.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    safe_frame = max(0, int(frame or 0))
    timestamp = safe_frame / max(1.0, float(fps or 30.0))
    temporary_output = output_path.with_name(f"{output_path.stem}.{uuid.uuid4().hex}.tmp.jpg")
    command = [
        ffmpeg_path,
        "-y",
        "-ss",
        f"{timestamp:.6f}",
        "-i",
        str(video_path),
        "-frames:v",
        "1",
        "-q:v",
        "3",
        str(temporary_output),
    ]
    try:
        with FRAME_PREVIEW_EXTRACT_SEMAPHORE:
            subprocess.run(command, check=True, capture_output=True, text=True)
        temporary_output.replace(output_path)
    except subprocess.CalledProcessError as exc:
        temporary_output.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Frame extraction failed: {exc.stderr[-1200:]}") from exc
    return output_path


def _run_ffmpeg_with_frame_progress(
    command: list[str],
    *,
    target_frames: int,
    on_progress,
) -> None:
    progress_command = [command[0], "-nostats", "-progress", "pipe:1", *command[1:]]
    process = subprocess.Popen(
        progress_command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    output_lines: list[str] = []
    last_progress = -1
    try:
        assert process.stdout is not None
        for line in process.stdout:
            clean_line = line.strip()
            if clean_line:
                output_lines.append(clean_line)
            if clean_line.startswith("frame="):
                try:
                    current_frame = int(clean_line.partition("=")[2])
                except ValueError:
                    continue
                progress = min(1.0, max(0.0, current_frame / max(1, target_frames)))
                progress_bucket = int(progress * 100)
                if progress_bucket >= last_progress + 2:
                    last_progress = progress_bucket
                    on_progress(progress)
        return_code = process.wait()
    except Exception:
        process.kill()
        process.wait()
        raise

    if return_code != 0:
        detail = "\n".join(output_lines[-40:])
        raise subprocess.CalledProcessError(return_code, progress_command, output=detail, stderr=detail)


def _create_calibration_range_videos(
    synchronized_folder: Path,
    recording_folder: Path,
    start_seconds: float,
    end_seconds: float,
) -> Path | None:
    start_seconds = max(0.0, float(start_seconds or 0))
    end_seconds = max(0.0, float(end_seconds or 0))
    if end_seconds <= 0 or end_seconds <= start_seconds:
        return None

    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise HTTPException(status_code=400, detail="FFmpeg is required for calibration range trimming and was not found.")

    source_videos = _mp4_paths(synchronized_folder)
    if len(source_videos) < 2:
        raise HTTPException(status_code=400, detail="Calibration requires at least two synchronized videos.")

    duration_seconds = end_seconds - start_seconds
    range_folder = recording_folder / f"calibration_range_videos_{uuid.uuid4().hex}"
    range_folder.mkdir(parents=True, exist_ok=False)
    try:
        for source_video in source_videos:
            output_path = range_folder / source_video.name
            command = [
                ffmpeg_path,
                "-y",
                "-ss",
                f"{start_seconds:.6f}",
                "-i",
                str(source_video),
                "-t",
                f"{duration_seconds:.6f}",
                "-map",
                "0:v:0",
                "-c:v",
                "copy",
                "-an",
                "-movflags",
                "+faststart",
                str(output_path),
            ]
            subprocess.run(command, check=True, capture_output=True, text=True)
        return range_folder
    except subprocess.CalledProcessError as exc:
        shutil.rmtree(range_folder, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Calibration range trim failed: {exc.stderr[-1200:]}") from exc


def _manual_resync_videos(source_folder: Path, synchronized_folder: Path, frame_offsets: dict[str, int], progress_callback=None) -> None:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise HTTPException(status_code=400, detail="FFmpeg is required for manual resync and was not found.")

    source_videos = _mp4_paths(source_folder)
    if not source_videos:
        raise HTTPException(status_code=400, detail="No synchronized videos found to resync.")

    unknown_names = sorted(set(frame_offsets) - {path.name for path in source_videos})
    if unknown_names:
        raise HTTPException(status_code=400, detail=f"Unknown video offset key: {unknown_names[0]}")

    temp_folder = synchronized_folder.with_name(f"{synchronized_folder.name}_manual_resync_{uuid.uuid4().hex}")
    temp_folder.mkdir(parents=True, exist_ok=False)
    source_frame_counts = {path.name: _probe_video_frame_count(path) for path in source_videos}
    raw_offsets = {path.name: int(frame_offsets.get(path.name, 0)) for path in source_videos}
    minimum_offset = min(raw_offsets.values(), default=0)
    normalized_offsets = {name: offset - minimum_offset for name, offset in raw_offsets.items()}
    target_frame_count = min(
        max(0, source_frame_counts[path.name] - normalized_offsets[path.name])
        for path in source_videos
    )
    if target_frame_count <= 0:
        raise HTTPException(status_code=400, detail="Manual resync offsets leave no overlapping video frames.")
    try:
        for index, source_video in enumerate(source_videos):
            offset_frames = normalized_offsets[source_video.name]
            output_path = temp_folder / source_video.name
            source_fps = _cached_video_fps(source_video)
            end_frame = offset_frames + target_frame_count
            video_filter = f"trim=start_frame={offset_frames}:end_frame={end_frame},setpts=PTS-STARTPTS"
            command = [
                ffmpeg_path,
                "-y",
                "-i",
                str(source_video),
                "-vf",
                video_filter,
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-r",
                f"{source_fps:g}",
                "-frames:v",
                str(target_frame_count),
                "-movflags",
                "+faststart",
                "-an",
                str(output_path),
            ]
            video_start_progress = 20 + round((index / len(source_videos)) * 40)
            video_end_progress = 20 + round(((index + 1) / len(source_videos)) * 40)
            if progress_callback:
                progress_callback(video_start_progress, f"Encoding camera {index + 1} of {len(source_videos)}: {source_video.name}.")

            def update_video_progress(progress: float) -> None:
                if not progress_callback:
                    return
                job_progress = video_start_progress + round((video_end_progress - video_start_progress) * progress)
                progress_callback(
                    job_progress,
                    f"Encoding camera {index + 1} of {len(source_videos)}: {source_video.name} ({round(progress * 100)}%).",
                )

            _run_ffmpeg_with_frame_progress(
                command,
                target_frames=target_frame_count,
                on_progress=update_video_progress,
            )

        resynced_videos = _mp4_paths(temp_folder)
        resynced_names = {path.name for path in resynced_videos}
        for resynced_video in resynced_videos:
            resynced_video.replace(synchronized_folder / resynced_video.name)
        for existing_video in _mp4_paths(synchronized_folder):
            if existing_video.name not in resynced_names:
                existing_video.unlink(missing_ok=True)
    except subprocess.CalledProcessError as exc:
        raise HTTPException(status_code=500, detail=f"Manual resync failed: {exc.stderr[-1200:]}") from exc
    finally:
        shutil.rmtree(temp_folder, ignore_errors=True)


def _parse_calibration_job_method(method: str | None) -> tuple[str, float]:
    if not method:
        return "7x5 Charuco", 39.0
    board_name = "7x5 Charuco" if "7x5" in method else "5x3 Charuco" if "5x3" in method else "7x5 Charuco"
    square_size = 39.0
    for token in method.replace(",", " ").split():
        try:
            square_size = float(token)
            break
        except ValueError:
            continue
    return board_name, square_size


def _parse_ground_plane_frame_from_method(method: str | None) -> int:
    if not method or "ground frame" not in method:
        return 0
    try:
        return max(0, int(method.rsplit("ground frame", 1)[1].strip().split()[0]))
    except (IndexError, ValueError):
        return 0


def _load_camera_projection(calibration_toml_path: Path | None, camera_name: str, camera_index: int = 0) -> dict | None:
    if calibration_toml_path is None or not calibration_toml_path.exists():
        return None

    try:
        calibration_data = tomllib.loads(calibration_toml_path.read_text())
    except Exception:
        return None

    camera_data = calibration_data.get(camera_name) or calibration_data.get(f"cam_{camera_index}")
    if camera_data is None:
        for key, value in calibration_data.items():
            if key.lower() == camera_name.lower() or camera_name.lower() in key.lower():
                camera_data = value
                break
    if not isinstance(camera_data, dict):
        return None

    try:
        import numpy as np

        matrix = np.asarray(camera_data.get("matrix"), dtype="float64")
        distortions = np.asarray(camera_data.get("distortions", [0, 0, 0, 0, 0]), dtype="float64")
        rotation = np.asarray(camera_data.get("rotation", [0, 0, 0]), dtype="float64")
        translation = np.asarray(camera_data.get("translation", [0, 0, 0]), dtype="float64")
    except Exception:
        return None

    if matrix.shape != (3, 3) or rotation.shape[0] != 3 or translation.shape[0] != 3:
        return None

    return {
        "matrix": matrix,
        "distortions": distortions,
        "rotation": rotation.reshape(3, 1),
        "translation": translation.reshape(3, 1),
    }


def _draw_projected_axes(frame, projection: dict | None, axis_length: float) -> None:
    if projection is None:
        return

    try:
        import cv2
        import numpy as np

        axis_points = np.float32(
            [
                [0, 0, 0],
                [axis_length, 0, 0],
                [0, axis_length, 0],
                [0, 0, -axis_length],
            ]
        )
        image_points, _ = cv2.projectPoints(
            axis_points,
            projection["rotation"],
            projection["translation"],
            projection["matrix"],
            projection["distortions"],
        )
        points = image_points.reshape(-1, 2).astype(int)
        origin = tuple(points[0])
        cv2.line(frame, origin, tuple(points[1]), (60, 80, 255), 3, cv2.LINE_AA)
        cv2.line(frame, origin, tuple(points[2]), (60, 210, 80), 3, cv2.LINE_AA)
        cv2.line(frame, origin, tuple(points[3]), (255, 120, 60), 3, cv2.LINE_AA)
        cv2.putText(frame, "X", tuple(points[1]), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (60, 80, 255), 2, cv2.LINE_AA)
        cv2.putText(frame, "Y", tuple(points[2]), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (60, 210, 80), 2, cv2.LINE_AA)
        cv2.putText(frame, "Z", tuple(points[3]), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 120, 60), 2, cv2.LINE_AA)
    except Exception:
        return


def _draw_detected_board_ground_plane(frame, marker_corners) -> bool:
    if marker_corners is None or len(marker_corners) < 2:
        return False

    try:
        import cv2
        import numpy as np

        marker_points = np.concatenate([corner.reshape(-1, 2) for corner in marker_corners]).astype("float32")
        if marker_points.shape[0] < 4:
            return False

        hull = cv2.convexHull(marker_points).astype("int32")
        if hull.shape[0] < 4:
            return False

        overlay = frame.copy()
        cv2.fillConvexPoly(overlay, hull, (70, 235, 210))
        cv2.addWeighted(overlay, 0.28, frame, 0.72, 0, frame)
        cv2.polylines(frame, [hull], True, (20, 245, 225), 4, cv2.LINE_AA)

        rect = cv2.minAreaRect(marker_points)
        box = cv2.boxPoints(rect).astype("int32")
        cv2.polylines(frame, [box], True, (10, 80, 255), 2, cv2.LINE_AA)
        label_points = hull.reshape(-1, 2)
        label_anchor = label_points[label_points[:, 1].argmin()]
        cv2.putText(
            frame,
            "detected ground-plane board",
            (max(18, int(label_anchor[0]) - 18), max(34, int(label_anchor[1]) - 14)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.62,
            (20, 245, 225),
            2,
            cv2.LINE_AA,
        )
        return True
    except Exception:
        return False


def _draw_charuco_overlay(
    frame,
    charuco_board,
    projection: dict | None,
    axis_length: float,
    camera_label: str,
    *,
    detect_board: bool = True,
    detection_cache: dict | None = None,
    emphasize_ground_plane: bool = False,
) -> int:
    import cv2

    detected_corners_count = 0
    marker_corners = None
    marker_ids = None
    charuco_corners = None
    charuco_ids = None

    if detect_board:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        dictionary = charuco_board.getDictionary()
        marker_corners, marker_ids, _ = cv2.aruco.detectMarkers(gray, dictionary)
        if marker_ids is not None and len(marker_ids):
            try:
                detected_corners_count, charuco_corners, charuco_ids = cv2.aruco.interpolateCornersCharuco(
                    marker_corners,
                    marker_ids,
                    gray,
                    charuco_board,
                )
            except Exception:
                detected_corners_count = len(marker_ids)
        if detection_cache is not None:
            detection_cache["marker_corners"] = marker_corners
            detection_cache["marker_ids"] = marker_ids
            detection_cache["charuco_corners"] = charuco_corners
            detection_cache["charuco_ids"] = charuco_ids
            detection_cache["detected_corners_count"] = int(detected_corners_count)
    elif detection_cache is not None:
        marker_corners = detection_cache.get("marker_corners")
        marker_ids = detection_cache.get("marker_ids")
        charuco_corners = detection_cache.get("charuco_corners")
        charuco_ids = detection_cache.get("charuco_ids")
        detected_corners_count = int(detection_cache.get("detected_corners_count") or 0)

    has_detected_ground_plane = False
    if emphasize_ground_plane:
        has_detected_ground_plane = _draw_detected_board_ground_plane(frame, marker_corners)
    if marker_ids is not None and marker_corners is not None and len(marker_ids):
        cv2.aruco.drawDetectedMarkers(frame, marker_corners, marker_ids)
    if detected_corners_count and charuco_corners is not None and charuco_ids is not None:
        cv2.aruco.drawDetectedCornersCharuco(frame, charuco_corners, charuco_ids, (20, 220, 220))

    height, width = frame.shape[:2]
    overlay = frame.copy()
    cv2.rectangle(overlay, (14, 14), (min(width - 14, 420), 90), (20, 28, 34), -1)
    cv2.addWeighted(overlay, 0.62, frame, 0.38, 0, frame)
    cv2.putText(frame, camera_label, (28, 45), cv2.FONT_HERSHEY_SIMPLEX, 0.72, (245, 250, 250), 2, cv2.LINE_AA)
    cv2.putText(
        frame,
        f"ChArUco corners: {int(detected_corners_count)}",
        (28, 75),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.58,
        (180, 235, 225),
        2,
        cv2.LINE_AA,
    )
    if emphasize_ground_plane:
        cv2.putText(
            frame,
            "Ground-plane frame" if has_detected_ground_plane else "Ground-plane frame, board not detected",
            (28, min(height - 64, 112)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.58,
            (180, 235, 225) if has_detected_ground_plane else (80, 170, 255),
            2,
            cv2.LINE_AA,
        )
    _draw_projected_axes(frame, projection, axis_length)
    return int(detected_corners_count)


def _encode_browser_safe_video(input_path: Path, output_path: Path) -> None:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise HTTPException(status_code=400, detail="FFmpeg is required for browser previews and was not found.")

    temporary_output = output_path.with_name(f"{output_path.stem}.{uuid.uuid4().hex}.tmp.mp4")
    command = [
        ffmpeg_path,
        "-y",
        "-i",
        str(input_path),
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
        raise HTTPException(status_code=500, detail=f"Overlay preview encoding failed: {exc.stderr[-1200:]}") from exc


def _create_calibration_overlay_preview(
    synchronized_folder: Path,
    recording_folder: Path,
    shot_id: str,
    force: bool = False,
    ground_plane_frame: int = 0,
) -> list[Path]:
    try:
        import cv2
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"OpenCV is required for calibration preview overlays: {exc}") from exc

    calibration = _get_calibration_functions()
    if "error" in calibration:
        raise HTTPException(status_code=500, detail=f"FreeMoCap calibration is not available: {calibration['error']}")

    latest_calibration_job = _latest_job_for_shot_type(shot_id, "calibration")
    board_name, square_size = _parse_calibration_job_method(latest_calibration_job["method"] if latest_calibration_job else None)
    if ground_plane_frame <= 0:
        ground_plane_frame = _parse_ground_plane_frame_from_method(
            latest_calibration_job["method"] if latest_calibration_job else None
        )
    charuco_board = calibration["CHARUCO_BOARDS"][board_name]().charuco_board
    calibration_toml_path = _get_calibration_toml_path(recording_folder)

    preview_folder = synchronized_folder / CALIBRATION_PREVIEW_VIDEOS_FOLDER_NAME
    preview_folder.mkdir(parents=True, exist_ok=True)
    preview_version_path = preview_folder / ".preview-version"
    if preview_version_path.exists() and preview_version_path.read_text().strip() != CALIBRATION_PREVIEW_ENCODER_VERSION:
        force = True
    elif not preview_version_path.exists():
        force = True

    source_videos = [path for path in _mp4_paths(synchronized_folder) if path.name != "side_by_side.mp4"]
    if len(source_videos) < 2:
        raise HTTPException(status_code=400, detail="Calibration preview requires at least two synchronized videos.")

    preview_paths: list[Path] = []
    for index, source_video in enumerate(source_videos):
        output_path = preview_folder / source_video.name
        if not force and output_path.exists() and output_path.stat().st_mtime >= source_video.stat().st_mtime:
            _create_browser_preview_poster(output_path)
            preview_paths.append(output_path)
            continue

        capture = cv2.VideoCapture(str(source_video))
        if not capture.isOpened():
            raise HTTPException(status_code=500, detail=f"Could not open {source_video.name} for calibration preview.")

        fps = capture.get(cv2.CAP_PROP_FPS) or 30
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        debug_frame_indices = {0}
        if frame_count > 0:
            debug_frame_indices.update({frame_count // 4, frame_count // 2, (frame_count * 3) // 4})
            if ground_plane_frame > 0:
                debug_frame_indices.add(min(frame_count - 1, ground_plane_frame))
        selected_ground_plane_frame = min(frame_count - 1, ground_plane_frame) if frame_count > 0 and ground_plane_frame > 0 else -1
        source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        preview_width = min(960, source_width)
        preview_height = int(source_height * (preview_width / source_width))
        if preview_height % 2:
            preview_height += 1
        camera_projection = _load_camera_projection(calibration_toml_path, source_video.stem, index)

        raw_overlay_path = output_path.with_name(f"{output_path.stem}.{uuid.uuid4().hex}.raw.mp4")
        writer = cv2.VideoWriter(
            str(raw_overlay_path),
            cv2.VideoWriter_fourcc(*"mp4v"),
            fps,
            (preview_width, preview_height),
        )
        if not writer.isOpened():
            capture.release()
            raise HTTPException(status_code=500, detail=f"Could not write calibration preview for {source_video.name}.")

        frame_index = 0
        detection_cache: dict = {}
        debug_frames_folder = preview_folder / "debug_frames"
        debug_frames_folder.mkdir(parents=True, exist_ok=True)
        try:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                _draw_charuco_overlay(
                    frame,
                    charuco_board,
                    camera_projection,
                    axis_length=max(square_size * 3, 100),
                    camera_label=f"Camera {index + 1}: {source_video.stem}",
                    detect_board=frame_index % 5 == 0,
                    detection_cache=detection_cache,
                    emphasize_ground_plane=frame_index == selected_ground_plane_frame,
                )
                if source_width != preview_width:
                    frame = cv2.resize(frame, (preview_width, preview_height), interpolation=cv2.INTER_AREA)
                if frame_index % 30 == 0:
                    cv2.putText(
                        frame,
                        f"Frame {frame_index}",
                        (28, preview_height - 28),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.58,
                        (245, 250, 250),
                        2,
                        cv2.LINE_AA,
                    )
                if frame_index in debug_frame_indices:
                    debug_frame_path = debug_frames_folder / f"{output_path.stem}_ground_plane_frame_{frame_index}.jpg"
                    cv2.imwrite(str(debug_frame_path), frame)
                writer.write(frame)
                frame_index += 1
        finally:
            writer.release()
            capture.release()

        _encode_browser_safe_video(raw_overlay_path, output_path)
        raw_overlay_path.unlink(missing_ok=True)
        _create_browser_preview_poster(output_path)
        preview_paths.append(output_path)

    _create_side_by_side_preview(preview_paths, preview_folder, force=force)
    preview_version_path.write_text(CALIBRATION_PREVIEW_ENCODER_VERSION)
    return preview_paths


def _monitor_sync_outputs(job_id: str, synchronized_folder: Path, expected_video_count: int, stop_event: threading.Event) -> None:
    last_progress = 40
    while not stop_event.wait(2):
        synced_videos = _mp4_paths(synchronized_folder)
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
        raw_videos = _mp4_paths(raw_folder)
        if not raw_videos:
            raise HTTPException(status_code=400, detail="No .mp4 videos were found for synchronization.")
        preview_preset = "veryfast"
        if method == "manual":
            _set_job(job_id, state="running", progress=35, message="Preparing manual frame alignment with FFmpeg.")
            _copy_videos_with_ffmpeg(raw_folder, synchronized_folder)
            preview_preset = "ultrafast"
        elif len(raw_videos) == 1:
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
        if method == "manual":
            complete_message = "Manual alignment clips are ready."
        else:
            _set_job(job_id, progress=90, message="Creating browser preview clips.")
            _create_browser_preview_videos(synchronized_folder, preset=preview_preset)
            complete_message = "Synchronized videos are ready."
        _set_job(job_id, state="complete", progress=100, message=complete_message, recording=recording)
    except Exception as exc:
        _set_job(job_id, state="failed", progress=100, message=str(exc))


def _run_manual_resync_job(job_id: str, shot_id: str, frame_offsets: dict[str, int]) -> None:
    try:
        shot = _get_shot(shot_id)
        recording_folder = Path(shot["recording_path"])
        raw_folder = Path(shot["raw_videos_path"])
        synchronized_folder = Path(shot["synchronized_videos_path"])
        source_folder = raw_folder if _mp4_paths(raw_folder) else synchronized_folder
        _set_job(job_id, state="running", progress=20, message="Applying exact frame offsets to synchronized videos.")
        _invalidate_downstream_jobs(shot_id)
        _manual_resync_videos(
            source_folder,
            synchronized_folder,
            frame_offsets,
            progress_callback=lambda progress, message: _set_job(job_id, progress=progress, message=message),
        )
        _set_job(job_id, progress=65, message="Clearing calibration and pose outputs from the previous sync.")
        _clear_downstream_artifacts(recording_folder)
        _set_job(job_id, progress=82, message="Refreshing manual alignment clips.")
        recording = _shot_to_recording(_get_shot(shot_id))
        _set_job(job_id, state="complete", progress=100, message="Manual frame resync complete.", recording=recording)
    except Exception as exc:
        detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
        _set_job(job_id, state="failed", progress=100, message=detail, error=detail)


def _calibration_progress_from_message(message: str, current_progress: int) -> tuple[int, str]:
    normalized = message.lower()
    if "successful" in normalized:
        return max(current_progress, 88), "Solved camera calibration."
    if "saved" in normalized or "toml" in normalized:
        return max(current_progress, 94), "Saving camera calibration TOML."
    if "ground" in normalized:
        return max(current_progress, 82), message
    return min(88, max(current_progress + 3, 35)), message


def _monitor_calibration_progress(job_id: str, stop_event: threading.Event, progress_state: dict[str, int]) -> None:
    stage_messages = [
        "Detecting ChArUco board corners in synchronized videos.",
        "Matching ChArUco observations across cameras.",
        "Solving camera intrinsics and extrinsics with Anipose.",
        "Refining camera capture volume.",
    ]
    index = 0
    while not stop_event.wait(3):
        progress = progress_state["progress"]
        progress = min(86, progress + 4)
        progress_state["progress"] = progress
        message = stage_messages[min(index, len(stage_messages) - 1)]
        _set_job(job_id, progress=progress, message=message)
        index += 1


def _monitor_motion_capture_outputs(job_id: str, recording_folder: Path, stop_event: threading.Event) -> None:
    stages = [
        ("data2d", 42, "2D tracking data saved."),
        ("raw3d", 68, "3D triangulation data saved."),
        ("data3d", 84, "3D skeleton output saved."),
        ("center_of_mass", 92, "Anatomical outputs saved."),
    ]
    last_progress = 20
    while not stop_event.wait(4):
        artifact = _motion_capture_artifact(recording_folder)
        next_progress = min(86, last_progress + 3)
        message = "Running FreeMoCap pose estimation."
        for key, progress, stage_message in stages:
            if artifact.get(key):
                next_progress = max(next_progress, progress)
                message = stage_message
        annotated_folder = recording_folder / ANNOTATED_VIDEOS_FOLDER_NAME
        annotated_videos = (
            [path for path in _mp4_paths(annotated_folder) if path.name != "side_by_side.mp4"]
            if annotated_folder.exists()
            else []
        )
        if annotated_videos:
            next_progress = max(next_progress, 88)
            message = f"Annotated pose videos available for {len(annotated_videos)} camera{'s' if len(annotated_videos) != 1 else ''}."
        if next_progress > last_progress:
            _set_job(job_id, progress=next_progress, message=message)
            last_progress = next_progress


def _run_motion_capture_job(job_id: str, shot_id: str, recording_folder: Path, minimum_cameras: int) -> None:
    stop_monitor = threading.Event()
    monitor = threading.Thread(
        target=_monitor_motion_capture_outputs,
        args=(job_id, recording_folder, stop_monitor),
        daemon=True,
    )
    try:
        _set_job(job_id, state="running", progress=20, message="Loading FreeMoCap pose estimation.")
        calibration_toml_path = _get_calibration_toml_path(recording_folder)
        if calibration_toml_path is None:
            raise FileNotFoundError("Run calibration before pose estimation.")

        motion_capture = _get_motion_capture_functions()
        if "error" in motion_capture:
            raise RuntimeError(f"FreeMoCap pose estimation is not available: {motion_capture['error']}")

        processing_parameters = motion_capture["ProcessingParameterModel"]()
        processing_parameters.anipose_triangulate_3d_parameters_model.minimum_cameras_for_triangulation = minimum_cameras
        monitor.start()
        motion_capture["process_recording_headless"](
            recording_path=recording_folder,
            path_to_camera_calibration_toml=calibration_toml_path,
            recording_processing_parameter_model=processing_parameters,
            run_blender=False,
            make_jupyter_notebook=False,
            use_tqdm=False,
        )
        annotated_folder = recording_folder / ANNOTATED_VIDEOS_FOLDER_NAME
        annotated_videos = [path for path in _mp4_paths(annotated_folder) if path.name != "side_by_side.mp4"]
        if annotated_videos:
            _set_job(job_id, progress=94, message="Creating pose preview.")
            for annotated_video in annotated_videos:
                _create_browser_preview_poster(annotated_video)
            _create_side_by_side_preview(
                annotated_videos,
                annotated_folder,
                force=True,
                tile_width=1280,
                crf=18,
                profile="high",
                level="5.0",
            )
        stop_monitor.set()
        monitor.join(timeout=1)
        recording = _status_for_recording(recording_folder)
        _set_job(job_id, state="complete", progress=100, message="Pose estimation outputs saved.")
        with SYNC_JOBS_LOCK:
            if job_id in SYNC_JOBS:
                SYNC_JOBS[job_id]["recording"] = recording
    except Exception as exc:
        stop_monitor.set()
        monitor.join(timeout=1)
        _set_job(job_id, state="failed", progress=100, message=str(exc), error=str(exc))


def _run_calibration_job(
    job_id: str,
    shot_id: str,
    synchronized_folder: Path,
    charuco_board_name: str,
    charuco_square_size_mm: float,
    use_charuco_as_groundplane: bool,
    ground_plane_frame: int,
    calibration_start_time: float,
    calibration_end_time: float,
) -> None:
    progress_state = {"progress": 25}
    stop_monitor = threading.Event()

    def progress_callback(message: str) -> None:
        progress, clean_message = _calibration_progress_from_message(message, progress_state["progress"])
        progress_state["progress"] = progress
        _set_job(job_id, progress=progress, message=clean_message)

    try:
        synced_videos = _mp4_paths(synchronized_folder)
        if len(synced_videos) < 2:
            raise HTTPException(status_code=400, detail="Calibration requires at least two synchronized videos.")

        calibration = _get_calibration_functions()
        if "error" in calibration:
            raise HTTPException(status_code=500, detail=f"FreeMoCap calibration is not available: {calibration['error']}")

        charuco_boards = calibration["CHARUCO_BOARDS"]
        if charuco_board_name not in charuco_boards:
            raise HTTPException(status_code=400, detail=f"Unknown ChArUco board: {charuco_board_name}.")
        if charuco_square_size_mm <= 0:
            raise HTTPException(status_code=400, detail="ChArUco square size must be greater than zero.")

        recording_folder = synchronized_folder.parent
        calibration_videos_folder = synchronized_folder
        range_folder = _create_calibration_range_videos(
            synchronized_folder,
            recording_folder,
            calibration_start_time,
            calibration_end_time,
        )
        if range_folder is not None:
            calibration_videos_folder = range_folder
            range_start_frame = round(max(0.0, calibration_start_time) * _cached_video_fps(synced_videos[0]))
            ground_plane_frame = max(0, ground_plane_frame - range_start_frame)
            _set_job(
                job_id,
                state="running",
                progress=22,
                message=f"Using calibration range {calibration_start_time:g}s to {calibration_end_time:g}s.",
            )

        _set_job(job_id, state="running", progress=25, message="Loading FreeMoCap Anipose calibration.")
        monitor = threading.Thread(
            target=_monitor_calibration_progress,
            args=(job_id, stop_monitor, progress_state),
            daemon=True,
        )
        monitor.start()
        try:
            if use_charuco_as_groundplane and ground_plane_frame > 0:
                from freemocap.core_processes.capture_volume_calibration.anipose_camera_calibration import (
                    anipose_camera_calibrator,
                )
                from freemocap.core_processes.capture_volume_calibration.anipose_camera_calibration.charuco_groundplane_utils import (
                    find_good_frame as upstream_find_good_frame,
                )

                original_find_good_frame = anipose_camera_calibrator.find_good_frame

                def find_good_frame_near_selected_frame(*args, **kwargs):
                    kwargs["frame_to_use"] = ground_plane_frame
                    return upstream_find_good_frame(*args, **kwargs)

                anipose_camera_calibrator.find_good_frame = find_good_frame_near_selected_frame
                try:
                    toml_path, groundplane_success = calibration["run_anipose_capture_volume_calibration"](
                        charuco_board_definition=charuco_boards[charuco_board_name](),
                        charuco_square_size=float(charuco_square_size_mm),
                        calibration_videos_folder_path=calibration_videos_folder,
                        pin_camera_0_to_origin=True,
                        use_charuco_as_groundplane=use_charuco_as_groundplane,
                        progress_callback=progress_callback,
                    )
                finally:
                    anipose_camera_calibrator.find_good_frame = original_find_good_frame
            else:
                toml_path, groundplane_success = calibration["run_anipose_capture_volume_calibration"](
                    charuco_board_definition=charuco_boards[charuco_board_name](),
                    charuco_square_size=float(charuco_square_size_mm),
                    calibration_videos_folder_path=calibration_videos_folder,
                    pin_camera_0_to_origin=True,
                    use_charuco_as_groundplane=use_charuco_as_groundplane,
                    progress_callback=progress_callback,
                )
        finally:
            stop_monitor.set()
            monitor.join(timeout=1)

        message = f"Calibration saved: {Path(toml_path).name}."
        if groundplane_success and groundplane_success.success is False:
            message = f"{message} Ground-plane alignment skipped: {groundplane_success.error}"

        recording = _shot_to_recording(_get_shot(shot_id))
        _set_job(job_id, state="complete", progress=100, message=message, recording=recording)
    except Exception as exc:
        stop_monitor.set()
        detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
        _set_job(job_id, state="failed", progress=100, message=detail, error=detail)
    finally:
        if "range_folder" in locals() and range_folder is not None:
            shutil.rmtree(range_folder, ignore_errors=True)


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
    calibration = _get_calibration_functions()
    motion_capture = _get_motion_capture_functions()
    return {
        "recording_session_folder_path": recording_session_folder_path,
        "sqlite_state_path": str(_db_path()),
        "ffmpeg_available": shutil.which("ffmpeg") is not None,
        "synchronization_available": "error" not in sync,
        "calibration_available": "error" not in calibration,
        "motion_capture_available": "error" not in motion_capture,
        "charuco_boards": sorted(calibration["CHARUCO_BOARDS"].keys()) if "error" not in calibration else [],
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
    local_video_paths: Annotated[str, Form()] = "",
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
            _save_sync_video_sources(files, local_video_paths, raw_tmp)
            _copy_timestamp_uploads(files, synchronized_folder)
            if synchronization_method == "manual":
                _copy_videos_with_ffmpeg(raw_tmp, synchronized_folder)
            else:
                _sync_videos(raw_tmp, synchronized_folder, synchronization_method, brightness_threshold)
        finally:
            shutil.rmtree(raw_tmp, ignore_errors=True)
    else:
        _save_sync_video_sources(files, local_video_paths, synchronized_folder)
        _copy_timestamp_uploads(files, synchronized_folder)

    return {"recording": _status_for_recording(recording_folder)}


@app.post("/api/sync-jobs")
def create_sync_job(
    recording_name: Annotated[str, Form()],
    purpose: Annotated[str, Form()] = "unassigned",
    synchronization_method: Annotated[str, Form()] = "audio",
    brightness_threshold: Annotated[float, Form()] = 1000.0,
    local_video_paths: Annotated[str, Form()] = "",
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
    saved_paths = _save_sync_video_sources(files, local_video_paths, raw_folder)

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
    _insert_job(
        job_id,
        shot["id"],
        job_type="sync",
        method=synchronization_method,
        message=f"Loaded {len(saved_paths)} videos.",
    )
    with SYNC_JOBS_LOCK:
        SYNC_JOBS[job_id] = {
            "id": job_id,
            "state": "queued",
            "progress": 15,
            "message": f"Loaded {len(saved_paths)} videos.",
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


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    return {"job": _get_job(job_id)}


@app.delete("/api/shots/{shot_id}")
def delete_shot(shot_id: str, force: bool = False) -> dict:
    return {"deleted": _delete_shot(shot_id, force=force)}


@app.post("/api/shots/{shot_id}/manual-resync-jobs")
def create_manual_resync_job(shot_id: str, payload: Annotated[dict, Body()]) -> dict:
    shot = _get_shot(shot_id)
    synchronized_folder = Path(shot["synchronized_videos_path"])
    synced_videos = _mp4_paths(synchronized_folder)
    if not synced_videos:
        raise HTTPException(status_code=400, detail="Run synchronization before manual frame resync.")

    latest_job = _latest_job_for_shot(shot_id)
    if latest_job and latest_job["state"] in {"queued", "running"}:
        raise HTTPException(status_code=409, detail="Wait for the current job to finish before manual resync.")

    raw_offsets = payload.get("offsets") if isinstance(payload, dict) else None
    if not isinstance(raw_offsets, dict):
        raise HTTPException(status_code=400, detail="Manual resync requires an offsets object.")
    frame_offsets = {
        str(name): max(-3000, min(3000, int(value)))
        for name, value in raw_offsets.items()
    }

    job_id = uuid.uuid4().hex
    method = ", ".join(f"{name}: {offset:+d}f" for name, offset in sorted(frame_offsets.items())) or "no offsets"
    _insert_job(
        job_id,
        shot_id,
        job_type="manual_resync",
        method=method,
        message="Queued manual frame resync.",
        progress=10,
    )
    with SYNC_JOBS_LOCK:
        SYNC_JOBS[job_id] = {
            "id": job_id,
            "state": "queued",
            "progress": 10,
            "message": "Queued manual frame resync.",
            "shot_id": shot_id,
            "recording_name": shot["name"],
            "recording_path": shot["recording_path"],
            "method": method,
            "type": "manual_resync",
            "recording": None,
        }

    worker = threading.Thread(
        target=_run_manual_resync_job,
        args=(job_id, shot_id, frame_offsets),
        daemon=True,
    )
    worker.start()
    return {"job": _get_job(job_id)}


@app.post("/api/shots/{shot_id}/calibration-jobs")
def create_calibration_job(
    shot_id: str,
    charuco_board_name: Annotated[str, Form()] = "7x5 Charuco",
    charuco_square_size_mm: Annotated[float, Form()] = 39.0,
    use_charuco_as_groundplane: Annotated[bool, Form()] = False,
    ground_plane_frame: Annotated[int, Form()] = 0,
    calibration_start_time: Annotated[float, Form()] = 0.0,
    calibration_end_time: Annotated[float, Form()] = 0.0,
) -> dict:
    shot = _get_shot(shot_id)
    synchronized_folder = Path(shot["synchronized_videos_path"])
    synced_videos = _mp4_paths(synchronized_folder)
    if len(synced_videos) < 2:
        raise HTTPException(status_code=400, detail="Run synchronization on at least two videos before calibration.")

    latest_job = _latest_job_for_shot(shot_id)
    if latest_job and latest_job["state"] in {"queued", "running"}:
        raise HTTPException(status_code=409, detail="Wait for the current job to finish before starting calibration.")

    job_id = uuid.uuid4().hex
    safe_start_time = max(0.0, float(calibration_start_time or 0))
    safe_end_time = max(0.0, float(calibration_end_time or 0))
    if safe_end_time > 0 and safe_end_time <= safe_start_time:
        raise HTTPException(status_code=400, detail="Calibration end time must be greater than start time.")

    range_text = f", range {safe_start_time:g}s-{safe_end_time:g}s" if safe_end_time > safe_start_time else ""
    method = f"{charuco_board_name}, {charuco_square_size_mm:g} mm, ground frame {max(0, ground_plane_frame)}{range_text}"
    _insert_job(
        job_id,
        shot_id,
        job_type="calibration",
        method=method,
        message="Queued FreeMoCap calibration.",
        progress=10,
    )
    with SYNC_JOBS_LOCK:
        SYNC_JOBS[job_id] = {
            "id": job_id,
            "state": "queued",
            "progress": 10,
            "message": "Queued FreeMoCap calibration.",
            "shot_id": shot_id,
            "recording_name": shot["name"],
            "recording_path": shot["recording_path"],
            "method": method,
            "type": "calibration",
            "recording": None,
        }

    worker = threading.Thread(
        target=_run_calibration_job,
        args=(
            job_id,
            shot_id,
            synchronized_folder,
            charuco_board_name,
            charuco_square_size_mm,
            use_charuco_as_groundplane,
            max(0, ground_plane_frame),
            safe_start_time,
            safe_end_time,
        ),
        daemon=True,
    )
    worker.start()
    return {"job": _get_job(job_id)}


@app.post("/api/shots/{shot_id}/motion-capture-jobs")
def create_motion_capture_job(
    shot_id: str,
    minimum_cameras_for_triangulation: Annotated[int, Form()] = 2,
) -> dict:
    shot = _get_shot(shot_id)
    recording_folder = Path(shot["recording_path"])
    synchronized_folder = Path(shot["synchronized_videos_path"])
    synced_videos = _mp4_paths(synchronized_folder)
    if not synced_videos:
        raise HTTPException(status_code=400, detail="Run synchronization before pose estimation.")
    if len(synced_videos) > 1 and _get_calibration_toml_path(recording_folder) is None:
        raise HTTPException(status_code=400, detail="Run calibration before multi-camera pose estimation.")

    latest_job = _latest_job_for_shot(shot_id)
    if latest_job and latest_job["state"] in {"queued", "running"}:
        raise HTTPException(status_code=409, detail="Wait for the current job to finish before starting pose estimation.")

    minimum_cameras = max(1, min(10, int(minimum_cameras_for_triangulation)))
    job_id = uuid.uuid4().hex
    method = f"FreeMoCap MediaPipe, min cameras {minimum_cameras}"
    _insert_job(
        job_id,
        shot_id,
        job_type="motion_capture",
        method=method,
        message="Queued FreeMoCap pose estimation.",
        progress=10,
    )
    with SYNC_JOBS_LOCK:
        SYNC_JOBS[job_id] = {
            "id": job_id,
            "state": "queued",
            "progress": 10,
            "message": "Queued FreeMoCap pose estimation.",
            "shot_id": shot_id,
            "recording_name": shot["name"],
            "recording_path": shot["recording_path"],
            "method": method,
            "type": "motion_capture",
            "recording": None,
        }

    worker = threading.Thread(
        target=_run_motion_capture_job,
        args=(job_id, shot_id, recording_folder, minimum_cameras),
        daemon=True,
    )
    worker.start()
    return {"job": _get_job(job_id)}


@app.post("/api/shots/{shot_id}/browser-previews")
def create_browser_previews(shot_id: str, force: bool = False) -> dict:
    shot = _get_shot(shot_id)
    synchronized_folder = Path(shot["synchronized_videos_path"])
    if not synchronized_folder.exists():
        raise HTTPException(status_code=404, detail="Synchronized videos folder not found.")
    preview_paths = _create_browser_preview_videos(synchronized_folder, force=force)
    return {"browser_videos": [path.name for path in preview_paths]}


@app.get("/api/shots/{shot_id}/frame-previews/{filename}")
def get_synchronized_frame_preview(
    shot_id: str,
    filename: str,
    frame: int = 0,
    offset: int = 0,
    request_id: int = 0,
):
    shot = _get_shot(shot_id)
    video_path = _synchronized_video_path(shot, filename)
    target_frame = max(0, int(frame or 0) + int(offset or 0))
    preview_folder = Path(shot["synchronized_videos_path"]) / "frame_preview_images"
    output_path = preview_folder / f"{video_path.stem}_frame_{target_frame}.jpg"
    request_key = _set_latest_frame_preview_request(shot_id, filename, int(request_id or 0))
    with _frame_preview_lock(output_path):
        if _is_stale_frame_preview_request(request_key, int(request_id or 0)):
            return Response(status_code=204, headers={"Cache-Control": "no-store"})
        if not output_path.exists() or output_path.stat().st_mtime < video_path.stat().st_mtime:
            _extract_video_frame(video_path, output_path, target_frame, fps=_cached_video_fps(video_path))
        if _is_stale_frame_preview_request(request_key, int(request_id or 0)):
            return Response(status_code=204, headers={"Cache-Control": "no-store"})

    return FileResponse(
        output_path,
        media_type="image/jpeg",
        filename=output_path.name,
        content_disposition_type="inline",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/shots/{shot_id}/pose-preview")
def create_pose_preview(shot_id: str, force: bool = False) -> dict:
    shot = _get_shot(shot_id)
    annotated_folder = Path(shot["recording_path"]) / ANNOTATED_VIDEOS_FOLDER_NAME
    if not annotated_folder.exists():
        raise HTTPException(status_code=400, detail="Run pose estimation before building pose preview.")

    annotated_videos = [path for path in _mp4_paths(annotated_folder) if path.name != "side_by_side.mp4"]
    if not annotated_videos:
        raise HTTPException(status_code=400, detail="No FreeMoCap annotated videos found.")

    for annotated_video in annotated_videos:
        _create_browser_preview_poster(annotated_video)
    side_by_side = _create_side_by_side_preview(
        annotated_videos,
        annotated_folder,
        force=force,
        tile_width=1280,
        crf=18,
        profile="high",
        level="5.0",
    )
    return {
        "pose_preview_videos": [path.name for path in annotated_videos],
        "pose_side_by_side_video": side_by_side.name,
    }


@app.post("/api/shots/{shot_id}/calibration-preview")
def create_calibration_preview(shot_id: str, force: bool = False, ground_plane_frame: int = 0) -> dict:
    shot = _get_shot(shot_id)
    synchronized_folder = Path(shot["synchronized_videos_path"])
    if not synchronized_folder.exists():
        raise HTTPException(status_code=404, detail="Synchronized videos folder not found.")
    preview_paths = _create_calibration_overlay_preview(
        synchronized_folder=synchronized_folder,
        recording_folder=Path(shot["recording_path"]),
        shot_id=shot_id,
        force=force,
        ground_plane_frame=max(0, ground_plane_frame),
    )
    return {
        "calibration_preview_videos": [path.name for path in preview_paths],
        "cache_key": _calibration_preview_cache_key(shot),
    }


@app.get("/api/shots/{shot_id}/videos/{filename}")
def get_synchronized_video(shot_id: str, filename: str) -> FileResponse:
    if Path(filename).name != filename or not filename.lower().endswith(VIDEO_SUFFIX):
        raise HTTPException(status_code=400, detail="Invalid video filename.")

    shot = _get_shot(shot_id)
    synchronized_folder = Path(shot["synchronized_videos_path"]).resolve()
    preview_folder = (synchronized_folder / BROWSER_PREVIEW_VIDEOS_FOLDER_NAME).resolve()
    video_path = (preview_folder / filename).resolve()
    if preview_folder not in video_path.parents or not video_path.exists():
        video_path = _synchronized_video_path(shot, filename)

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


@app.get("/api/shots/{shot_id}/calibration-preview-videos/{filename}")
def get_calibration_preview_video(shot_id: str, filename: str) -> FileResponse:
    if Path(filename).name != filename or not filename.lower().endswith(VIDEO_SUFFIX):
        raise HTTPException(status_code=400, detail="Invalid video filename.")

    shot = _get_shot(shot_id)
    preview_folder = (
        Path(shot["synchronized_videos_path"]) / CALIBRATION_PREVIEW_VIDEOS_FOLDER_NAME
    ).resolve()
    video_path = (preview_folder / filename).resolve()
    if preview_folder not in video_path.parents or not video_path.exists():
        raise HTTPException(status_code=404, detail="Calibration preview video not found.")

    return FileResponse(
        video_path,
        media_type="video/mp4",
        filename=filename,
        content_disposition_type="inline",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/shots/{shot_id}/calibration-preview-posters/{filename}")
def get_calibration_preview_poster(shot_id: str, filename: str) -> FileResponse:
    if Path(filename).name != filename or not filename.lower().endswith(".jpg"):
        raise HTTPException(status_code=400, detail="Invalid poster filename.")

    shot = _get_shot(shot_id)
    preview_folder = (
        Path(shot["synchronized_videos_path"]) / CALIBRATION_PREVIEW_VIDEOS_FOLDER_NAME
    ).resolve()
    poster_path = (preview_folder / filename).resolve()
    if preview_folder not in poster_path.parents or not poster_path.exists():
        raise HTTPException(status_code=404, detail="Calibration preview poster not found.")

    return FileResponse(
        poster_path,
        media_type="image/jpeg",
        filename=filename,
        content_disposition_type="inline",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/shots/{shot_id}/calibration-preview-frames/{filename}")
def get_calibration_preview_frame(shot_id: str, filename: str) -> FileResponse:
    if Path(filename).name != filename or not filename.lower().endswith(".jpg"):
        raise HTTPException(status_code=400, detail="Invalid calibration preview frame filename.")

    shot = _get_shot(shot_id)
    frames_folder = (
        Path(shot["synchronized_videos_path"]) / CALIBRATION_PREVIEW_VIDEOS_FOLDER_NAME / "debug_frames"
    ).resolve()
    frame_path = (frames_folder / filename).resolve()
    if frames_folder not in frame_path.parents or not frame_path.exists():
        raise HTTPException(status_code=404, detail="Calibration preview frame not found.")

    return FileResponse(
        frame_path,
        media_type="image/jpeg",
        filename=filename,
        content_disposition_type="inline",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/shots/{shot_id}/pose-3d")
def get_pose_3d(shot_id: str, max_frames: int = 1800) -> dict:
    shot = _get_shot(shot_id)
    recording_folder = Path(shot["recording_path"])
    pose_path = _pose_3d_body_path(recording_folder)
    if pose_path is None or not pose_path.exists():
        raise HTTPException(status_code=404, detail="Pose 3D data not found. Run pose estimation first.")

    try:
        import numpy as np
    except ImportError as error:
        raise HTTPException(status_code=500, detail="NumPy is required to read FreeMoCap pose data.") from error

    pose_data = np.load(pose_path)
    if pose_data.ndim != 3 or pose_data.shape[2] != 3:
        raise HTTPException(status_code=500, detail=f"Unsupported pose 3D data shape: {pose_data.shape}.")

    frame_count = int(pose_data.shape[0])
    marker_count = int(pose_data.shape[1])
    safe_max_frames = max(30, min(int(max_frames or 1800), 3000))
    stride = max(1, math.ceil(frame_count / safe_max_frames))
    sampled = pose_data[::stride].astype(float)
    finite_values = sampled[np.isfinite(sampled)]
    bounds = {
        "min": [0, 0, 0],
        "max": [0, 0, 0],
    }
    if finite_values.size:
        bounds = {
            "min": np.nanmin(sampled, axis=(0, 1)).round(2).tolist(),
            "max": np.nanmax(sampled, axis=(0, 1)).round(2).tolist(),
        }
    sampled = np.nan_to_num(sampled, nan=0.0, posinf=0.0, neginf=0.0)
    sampled = np.round(sampled, 2)

    return {
        "source": pose_path.name,
        "fps": _pose_3d_fps(recording_folder),
        "stride": stride,
        "frame_count": frame_count,
        "sampled_frame_count": int(sampled.shape[0]),
        "marker_count": marker_count,
        "marker_names": _pose_3d_marker_names(recording_folder, marker_count),
        "bounds": bounds,
        "frames": sampled.tolist(),
    }


@app.get("/api/shots/{shot_id}/pose-preview-videos/{filename}")
def get_pose_preview_video(shot_id: str, filename: str) -> FileResponse:
    if Path(filename).name != filename or not filename.lower().endswith(VIDEO_SUFFIX):
        raise HTTPException(status_code=400, detail="Invalid pose preview video filename.")

    shot = _get_shot(shot_id)
    annotated_folder = (Path(shot["recording_path"]) / ANNOTATED_VIDEOS_FOLDER_NAME).resolve()
    video_path = (annotated_folder / filename).resolve()
    if annotated_folder not in video_path.parents or not video_path.exists():
        raise HTTPException(status_code=404, detail="Pose preview video not found.")

    return FileResponse(
        video_path,
        media_type="video/mp4",
        filename=filename,
        content_disposition_type="inline",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/shots/{shot_id}/pose-preview-posters/{filename}")
def get_pose_preview_poster(shot_id: str, filename: str) -> FileResponse:
    if Path(filename).name != filename or not filename.lower().endswith(".jpg"):
        raise HTTPException(status_code=400, detail="Invalid pose preview poster filename.")

    shot = _get_shot(shot_id)
    annotated_folder = (Path(shot["recording_path"]) / ANNOTATED_VIDEOS_FOLDER_NAME).resolve()
    poster_path = (annotated_folder / filename).resolve()
    if annotated_folder not in poster_path.parents or not poster_path.exists():
        raise HTTPException(status_code=404, detail="Pose preview poster not found.")

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
