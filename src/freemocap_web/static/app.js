import { mountPose3dViewer } from "./pose3d.js";

const form = document.querySelector("#syncForm");
const appShell = document.querySelector("#appShell");
const projectOnboarding = document.querySelector("#projectOnboarding");
const createProjectForm = document.querySelector("#createProjectForm");
const projectNameInput = document.querySelector("#projectNameInput");
const projectNameCard = document.querySelector("#projectNameCard");
const fileInput = document.querySelector("#fileInput");
const jobConsole = document.querySelector("#jobConsole");
const selectedVideoSummary = document.querySelector("#selectedVideoSummary");
const syncStatus = document.querySelector("#syncStatus");
const sidebarShotsList = document.querySelector("#sidebarShotsList");
const systemStatus = document.querySelector("#systemStatus");
const refreshButton = document.querySelector("#refreshButton");
const detailRefreshButton = document.querySelector("#detailRefreshButton");
const createShotNav = document.querySelector("#createShotNav");
const recordingName = document.querySelector("#recordingName");
const dropzone = document.querySelector("#dropzone");
const syncButton = document.querySelector("#syncButton");
const createShotPanel = document.querySelector("#syncForm");
const shotDetailPanel = document.querySelector("#shotDetailPanel");
const selectedShotName = document.querySelector("#selectedShotName");
const selectedShotPurpose = document.querySelector("#selectedShotPurpose");
const selectedShotState = document.querySelector("#selectedShotState");
const selectedShotVideoCount = document.querySelector("#selectedShotVideoCount");
const selectedShotVideos = document.querySelector("#selectedShotVideos");
const detailProgressTitle = document.querySelector("#detailProgressTitle");
const detailProgressPercent = document.querySelector("#detailProgressPercent");
const detailProgressFill = document.querySelector("#detailProgressFill");
const detailProgressMessage = document.querySelector("#detailProgressMessage");
const detailLogLineOne = document.querySelector("#detailLogLineOne");
const detailLogLineTwo = document.querySelector("#detailLogLineTwo");
const progressTitle = document.querySelector("#progressTitle");
const progressPercent = document.querySelector("#progressPercent");
const progressFill = document.querySelector("#progressFill");
const progressMessage = document.querySelector("#progressMessage");
const logLineOne = document.querySelector("#logLineOne");
const logLineTwo = document.querySelector("#logLineTwo");
const calibrationForm = document.querySelector("#calibrationForm");
const calibrationButton = document.querySelector("#calibrationButton");
const calibrationStatus = document.querySelector("#calibrationStatus");
const calibrationState = document.querySelector("#calibrationState");
const calibrationStage = document.querySelector("#calibrationStage");
const charucoBoardName = document.querySelector("#charucoBoardName");
const charucoSquareSize = document.querySelector("#charucoSquareSize");
const useCharucoGroundplane = document.querySelector("#useCharucoGroundplane");
const groundPlaneFrame = document.querySelector("#groundPlaneFrame");
const pickGroundPlaneFrameButton = document.querySelector("#pickGroundPlaneFrameButton");
const calibrationPreviewButton = document.querySelector("#calibrationPreviewButton");
const calibrationPreviewStatus = document.querySelector("#calibrationPreviewStatus");
const calibrationPreviewPlayer = document.querySelector("#calibrationPreviewPlayer");
const calibrationResultArtifact = document.querySelector("#calibrationResultArtifact");
const motionState = document.querySelector("#motionState");
const motionStage = document.querySelector("#motionStage");
const motionButton = document.querySelector("#motionButton");
const motionStatus = document.querySelector("#motionStatus");
const motionResultArtifact = document.querySelector("#motionResultArtifact");
const posePreviewButton = document.querySelector("#posePreviewButton");
const posePreviewStatus = document.querySelector("#posePreviewStatus");
const posePreviewPlayer = document.querySelector("#posePreviewPlayer");
const pose3dViewer = document.querySelector("#pose3dViewer");
const detailTabButtons = Array.from(document.querySelectorAll("[data-detail-tab]"));
const detailTabPanels = Array.from(document.querySelectorAll("[data-detail-tab-panel]"));

let pollTimer = null;
let activeJobId = null;
let selectedShotId = null;
let recordingsCache = [];
let activeView = null;
let lastGroundPlaneVideo = null;
let activeDetailTab = "calibration";

function defaultRecordingName() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "_");
  return `shot_${stamp}`;
}

function selectedVideos() {
  return Array.from(fileInput.files || []).filter((file) => file.name.toLowerCase().endsWith(".mp4"));
}

function formatSize(bytes) {
  if (!bytes) return "0 MB";
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function setCreateProgress(progress, title, message) {
  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  progressTitle.textContent = title;
  progressPercent.textContent = `${safeProgress}%`;
  progressFill.style.width = `${safeProgress}%`;
  progressMessage.textContent = message;
}

function setCreateLog(lineOne, lineTwo) {
  logLineOne.textContent = lineOne;
  logLineTwo.textContent = lineTwo;
}

function setDetailProgress(progress, title, message) {
  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  detailProgressTitle.textContent = title;
  detailProgressPercent.textContent = `${safeProgress}%`;
  detailProgressFill.style.width = `${safeProgress}%`;
  detailProgressMessage.textContent = message;
}

function setDetailLog(lineOne, lineTwo) {
  detailLogLineOne.textContent = lineOne;
  detailLogLineTwo.textContent = lineTwo;
}

function showDetailTab(tabName) {
  activeDetailTab = tabName;
  detailTabButtons.forEach((button) => {
    const selected = button.dataset.detailTab === tabName;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
  detailTabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.detailTabPanel !== tabName;
  });
  if (tabName === "pose-result") {
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }
}

function renderVideos() {
  const videos = selectedVideos();
  const bytes = videos.reduce((total, file) => total + file.size, 0);
  appShell.classList.toggle("has-selection", videos.length > 0);

  if (videos.length >= 2) {
    syncButton.disabled = false;
    syncStatus.textContent = "";
    selectedVideoSummary.textContent = `${videos.length} videos selected`;
    setCreateProgress(0, "Ready", `Run Skelly sync when these ${videos.length} videos look right.`);
    setCreateLog(`${videos.length} source videos selected`, `${formatSize(bytes)} ready for upload`);
  } else if (videos.length === 1) {
    syncButton.disabled = false;
    syncStatus.textContent = "";
    selectedVideoSummary.textContent = "1 video selected";
    setCreateProgress(0, "Ready", "Prepare this single-video shot for downstream processing.");
    setCreateLog("1 source video selected", `${formatSize(bytes)} ready for upload`);
  } else {
    syncButton.disabled = true;
    selectedVideoSummary.textContent = "Select videos";
    setCreateProgress(0, "Waiting for videos", "Select one or more MP4 files to create a shot.");
    setCreateLog("Waiting for source videos", "Select camera files from the same shot");
  }
}

function setBusy(isBusy) {
  form.querySelectorAll("button, input, select").forEach((element) => {
    element.disabled = isBusy;
  });
  fileInput.disabled = isBusy;
  if (!isBusy) {
    syncButton.disabled = selectedVideos().length < 1;
  }
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = body.detail || detail;
    } catch {
      detail = response.statusText;
    }
    throw new Error(detail);
  }
  return response.json();
}

function renderProject(project) {
  projectNameCard.textContent = project.name;
}

function showProjectOnboarding() {
  projectOnboarding.classList.remove("app-hidden");
  appShell.classList.add("app-hidden");
  projectNameInput.focus();
}

function showApp() {
  projectOnboarding.classList.add("app-hidden");
  appShell.classList.remove("app-hidden");
}

function renderSystem(system) {
  const sync = system.synchronization_available ? "sync ready" : "sync unavailable";
  const calibration = system.calibration_available ? "calibration ready" : "calibration unavailable";
  const motion = system.motion_capture_available ? "pose ready" : "pose unavailable";
  const ffmpeg = system.ffmpeg_available ? "FFmpeg found" : "FFmpeg missing";
  systemStatus.textContent = `${system.recording_session_folder_path}\n${ffmpeg}, ${sync}, ${calibration}, ${motion}`;

  if (Array.isArray(system.charuco_boards) && system.charuco_boards.length) {
    const current = charucoBoardName.value;
    charucoBoardName.innerHTML = system.charuco_boards
      .map((board) => `<option value="${board}">${board}</option>`)
      .join("");
    if (system.charuco_boards.includes(current)) {
      charucoBoardName.value = current;
    }
  }
}

function purposeLabel(purpose) {
  const purposeLabels = {
    calibration: "Calibration",
    motion_capture: "Motion capture",
    unassigned: "Unassigned",
  };
  return purposeLabels[purpose] || "Unassigned";
}

function shotState(recording) {
  const job = recording.latest_job;
  const hasVideos = Boolean(recording.status?.synchronized_videos_status_check);
  const hasCalibration = Boolean(recording.status?.calibration_toml_check);
  const hasMotionCapture = Boolean(recording.status?.data3d_status_check);
  if (job?.state === "failed") return { className: "failed", text: "Failed" };
  if (["queued", "running"].includes(job?.state)) {
    if (job.type === "calibration") return { className: "pending", text: `Cal ${job.progress}%` };
    if (job.type === "motion_capture") return { className: "pending", text: `Pose ${job.progress}%` };
    return { className: "pending", text: `${job.progress}%` };
  }
  if (hasMotionCapture) return { className: "", text: "Pose ready" };
  if (hasCalibration) return { className: "", text: "Calibrated" };
  if (hasVideos || job?.state === "complete") return { className: "", text: "Synced" };
  return { className: "pending", text: "Draft" };
}

function jobTitle(job) {
  if (!job) return "No job";
  if (job.state === "complete") return "Complete";
  if (job.state === "failed") return "Failed";
  if (job.state === "queued") return "Queued";
  if (job.type === "calibration") return "Calibrating";
  if (job.type === "motion_capture") return "Estimating pose";
  return "Syncing";
}

function syncedVideoCount(shot) {
  return Number(shot.video_count) || 0;
}

function canRunCalibration(shot) {
  const running = ["queued", "running"].includes(shot.latest_job?.state);
  return syncedVideoCount(shot) >= 2 && !running;
}

function canRunMotionCapture(shot) {
  const running = ["queued", "running"].includes(shot.latest_job?.state);
  const hasSync = syncedVideoCount(shot) >= 1;
  const hasCalibration = Boolean(shot.status?.calibration_toml_check) || syncedVideoCount(shot) === 1;
  return hasSync && hasCalibration && !running;
}

function estimateShotFrameRate(shot, video) {
  const frameCounts = Object.values(shot.status?.video_and_camera_info?.number_of_frames_in_videos || {})
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const frameCount = frameCounts.length ? Math.min(...frameCounts) : 0;
  if (frameCount && Number.isFinite(video.duration) && video.duration > 0) {
    return frameCount / video.duration;
  }
  return 30;
}

function bindGroundPlaneFramePicker(container) {
  container.querySelectorAll("video").forEach((video) => {
    if (video.dataset.framePickerBound === "true") return;
    video.dataset.framePickerBound = "true";
    const remember = () => {
      lastGroundPlaneVideo = video;
    };
    video.addEventListener("pointerdown", remember);
    video.addEventListener("focus", remember);
    video.addEventListener("play", remember);
    video.addEventListener("seeking", remember);
    video.addEventListener("timeupdate", remember);
  });
}

function activeGroundPlaneVideo() {
  const candidates = [
    ...selectedShotVideos.querySelectorAll("video"),
    ...calibrationPreviewPlayer.querySelectorAll("video"),
  ];
  if (lastGroundPlaneVideo && candidates.includes(lastGroundPlaneVideo)) {
    return lastGroundPlaneVideo;
  }

  return (
    candidates.find((video) => !video.paused && !video.ended) ||
    candidates.find((video) => (video.currentTime || 0) > 0) ||
    candidates[0] ||
    null
  );
}

function pickGroundPlaneFrameFromPlayer() {
  const shot = recordingsCache.find((recording) => recording.id === selectedShotId);
  const video = activeGroundPlaneVideo();
  if (!shot || !video) {
    calibrationStatus.innerHTML = `<span class="error">Open a shot with a video player first.</span>`;
    return;
  }

  const fps = estimateShotFrameRate(shot, video);
  const frame = Math.max(0, Math.round((video.currentTime || 0) * fps));
  groundPlaneFrame.value = String(frame);
  useCharucoGroundplane.checked = true;
  calibrationStatus.textContent = `Ground-plane frame set to ${frame}.`;
}

function updateCalibrationStages(job, shot) {
  const progress = job?.type === "calibration" ? Number(job.progress) || 0 : 0;
  const hasSync = syncedVideoCount(shot) >= 2;
  const hasCalibration = Boolean(shot.status?.calibration_toml_check);
  const activeStages = new Set();
  if (hasSync) activeStages.add("sync");
  if (progress >= 30 || hasCalibration) activeStages.add("detect");
  if (progress >= 60 || hasCalibration) activeStages.add("solve");
  if (progress >= 90 || hasCalibration) activeStages.add("save");

  calibrationStage.querySelectorAll("[data-stage]").forEach((stage) => {
    stage.classList.toggle("is-active", activeStages.has(stage.dataset.stage));
  });
}

function renderCalibrationWorkbench(shot) {
  const job = shot.latest_job;
  const runningCalibration = job?.type === "calibration" && ["queued", "running"].includes(job.state);
  const hasCalibration = Boolean(shot.status?.calibration_toml_check);
  const ready = canRunCalibration(shot);

  calibrationButton.disabled = !ready;
  calibrationForm.querySelectorAll("input, select").forEach((field) => {
    field.disabled = runningCalibration;
  });

  if (runningCalibration) {
    calibrationState.textContent = `${job.progress}%`;
    calibrationStatus.textContent = job.message;
  } else if (hasCalibration) {
    calibrationState.textContent = "Calibrated";
    calibrationStatus.textContent = shot.calibration_toml_name || "Camera calibration saved.";
  } else if (syncedVideoCount(shot) < 2) {
    calibrationState.textContent = "Needs synced videos";
    calibrationStatus.textContent = "Sync at least two videos before calibration.";
  } else {
    calibrationState.textContent = "Ready";
    calibrationStatus.textContent = "Uses FreeMoCap Anipose calibration on this shot's synced videos.";
  }

  updateCalibrationStages(job, shot);
  renderCalibrationPreview(shot);
}

function mediaCacheKey(shot) {
  return shot.browser_preview_updated_at || shot.side_by_side_updated_at || Date.now();
}

function calibrationPreviewCacheKey(shot) {
  return shot.calibration_preview_updated_at || Date.now();
}

function videoUrl(shot, filename) {
  return `/api/shots/${encodeURIComponent(shot.id)}/videos/${encodeURIComponent(filename)}?v=${encodeURIComponent(mediaCacheKey(shot))}`;
}

function posterUrl(shot, filename) {
  const posterName = filename.replace(/\.mp4$/i, ".jpg");
  return `/api/shots/${encodeURIComponent(shot.id)}/posters/${encodeURIComponent(posterName)}?v=${encodeURIComponent(mediaCacheKey(shot))}`;
}

function calibrationPreviewVideoUrl(shot, filename) {
  return `/api/shots/${encodeURIComponent(shot.id)}/calibration-preview-videos/${encodeURIComponent(filename)}?v=${encodeURIComponent(calibrationPreviewCacheKey(shot))}`;
}

function calibrationPreviewPosterUrl(shot, filename) {
  const posterName = filename.replace(/\.mp4$/i, ".jpg");
  return `/api/shots/${encodeURIComponent(shot.id)}/calibration-preview-posters/${encodeURIComponent(posterName)}?v=${encodeURIComponent(calibrationPreviewCacheKey(shot))}`;
}

function calibrationPreviewFrameUrl(shot, filename) {
  return `/api/shots/${encodeURIComponent(shot.id)}/calibration-preview-frames/${encodeURIComponent(filename)}?v=${encodeURIComponent(calibrationPreviewCacheKey(shot))}`;
}

function posePreviewCacheKey(shot) {
  return shot.pose_preview_updated_at || Date.now();
}

function posePreviewVideoUrl(shot, filename) {
  return `/api/shots/${encodeURIComponent(shot.id)}/pose-preview-videos/${encodeURIComponent(filename)}?v=${encodeURIComponent(posePreviewCacheKey(shot))}`;
}

function posePreviewPosterUrl(shot, filename) {
  const posterName = filename.replace(/\.mp4$/i, ".jpg");
  return `/api/shots/${encodeURIComponent(shot.id)}/pose-preview-posters/${encodeURIComponent(posterName)}?v=${encodeURIComponent(posePreviewCacheKey(shot))}`;
}

function pose3dUrl(shot) {
  const dataKey = shot.motion_capture_artifact?.data3d?.size_bytes || shot.latest_job?.updated_at || posePreviewCacheKey(shot);
  return `/api/shots/${encodeURIComponent(shot.id)}/pose-3d?v=${encodeURIComponent(dataKey)}`;
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = Math.floor(safeSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

function renderSideBySidePlayer(shot) {
  if (shot.side_by_side_video) {
    return `
      <article class="combined-player">
        <video controls playsinline preload="metadata" poster="${posterUrl(shot, shot.side_by_side_video)}" src="${videoUrl(shot, shot.side_by_side_video)}"></video>
        <div>
          <strong>Synced side-by-side preview</strong>
          <span>${shot.video_count} synced clips in one browser player</span>
        </div>
      </article>
    `;
  }

  const playableVideos = (shot.browser_videos || []).filter((video) => video !== shot.side_by_side_video);
  if (!playableVideos.length) {
    return `<div class="video-row muted">No synchronized videos found</div>`;
  }

  const videoMarkup = playableVideos
    .map(
      (video, index) => `
        <figure class="linked-clip">
          <video controls muted playsinline preload="auto" poster="${posterUrl(shot, video)}" src="${videoUrl(shot, video)}"></video>
          <figcaption>
            <strong>Camera ${index + 1}</strong>
            <span>${video}</span>
          </figcaption>
        </figure>
      `,
    )
    .join("");

  return `
    <article class="linked-player" data-linked-player>
      <div class="linked-video-grid">
        ${videoMarkup}
      </div>
      <div class="linked-controls">
        <button class="primary" type="button" data-linked-play>Play</button>
        <span data-linked-time>0:00 / 0:00</span>
        <input data-linked-seek type="range" min="0" max="1000" value="0" step="1" />
        <output data-linked-status></output>
      </div>
    </article>
  `;
}

function renderCalibrationPreviewPlayer(shot) {
  if (!shot.calibration_preview_ready || !shot.calibration_side_by_side_video) {
    return "";
  }

  const debugFrames = shot.calibration_debug_frames || [];
  const debugFrameMarkup = debugFrames.length
    ? `
      <section class="calibration-debug-frames" aria-label="Calibration debug frames">
        <div class="debug-frame-heading">
          <strong>Debug frames</strong>
          <span>${debugFrames.length} rendered still${debugFrames.length === 1 ? "" : "s"}</span>
        </div>
        <div class="debug-frame-grid">
          ${debugFrames
            .map((frame) => {
              const match = frame.match(/frame_(\d+)\.jpg$/i);
              const label = match ? `Frame ${match[1]}` : frame.replace(/\.jpg$/i, "");
              const url = calibrationPreviewFrameUrl(shot, frame);
              return `
                <a class="debug-frame" href="${url}" target="_blank" rel="noreferrer">
                  <img src="${url}" alt="Calibration overlay debug still for ${label}" loading="lazy" />
                  <span>${label}</span>
                </a>
              `;
            })
            .join("")}
        </div>
      </section>
    `
    : `<div class="video-row muted">No debug still frames have been rendered yet.</div>`;

  return `
    <article class="combined-player calibration-overlay-player">
      <video controls playsinline preload="metadata" poster="${calibrationPreviewPosterUrl(shot, shot.calibration_side_by_side_video)}" src="${calibrationPreviewVideoUrl(shot, shot.calibration_side_by_side_video)}"></video>
      <div>
        <strong>ChArUco overlay preview</strong>
        <span>Detected board features and calibration axes burned into a derived preview.</span>
      </div>
    </article>
    ${debugFrameMarkup}
  `;
}

function renderPosePreviewPlayer(shot) {
  if (!shot.pose_preview_ready || !shot.pose_side_by_side_video) {
    return "";
  }

  const sourceCount = (shot.pose_preview_videos || []).filter((video) => video !== shot.pose_side_by_side_video).length;
  return `
    <article class="combined-player pose-preview-player">
      <video controls playsinline preload="metadata" poster="${posePreviewPosterUrl(shot, shot.pose_side_by_side_video)}" src="${posePreviewVideoUrl(shot, shot.pose_side_by_side_video)}"></video>
      <div>
        <strong>Annotated pose preview</strong>
        <span>${sourceCount || shot.video_count} FreeMoCap annotated clip${(sourceCount || shot.video_count) === 1 ? "" : "s"} in one browser player</span>
      </div>
    </article>
  `;
}

function formatCalibrationValue(value, suffix = "") {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return `${Number(value).toFixed(1)}${suffix}`;
  return `${value}${suffix}`;
}

function renderCalibrationArtifact(shot) {
  const artifact = shot.calibration_artifact;
  if (!artifact) {
    calibrationResultArtifact.innerHTML = `<div class="video-row muted">Run calibration to create a camera layout artifact.</div>`;
    return;
  }

  const positions = artifact.cameras
    .map((camera) => camera.world_position || [0, 0, 0])
    .filter((position) => position.length >= 3);
  const xs = positions.map((position) => Number(position[0]) || 0);
  const zs = positions.map((position) => Number(position[2]) || 0);
  const minX = Math.min(...xs, -1000);
  const maxX = Math.max(...xs, 1000);
  const minZ = Math.min(...zs, -1000);
  const maxZ = Math.max(...zs, 1000);
  const spanX = Math.max(1, maxX - minX);
  const spanZ = Math.max(1, maxZ - minZ);

  const cameraMarkers = artifact.cameras
    .map((camera, index) => {
      const position = camera.world_position || [0, 0, 0];
      const xPercent = 10 + (((Number(position[0]) || 0) - minX) / spanX) * 80;
      const zPercent = 10 + (((Number(position[2]) || 0) - minZ) / spanZ) * 80;
      const left = 18 + xPercent * 0.64;
      const top = 80 - zPercent * 0.34;
      return `
        <span class="camera-marker" style="left:${left.toFixed(2)}%; top:${top.toFixed(2)}%; --depth:${zPercent.toFixed(2)}%">
          <strong>${index + 1}</strong>
          <small>${camera.name}</small>
        </span>
      `;
    })
    .join("");

  calibrationResultArtifact.innerHTML = `
    <article class="calibration-artifact">
      <div class="calibration-map">
        <div class="ground-plane-scene">
          <span class="map-grid"></span>
          <span class="ground-origin-point"></span>
          <span class="ground-axis ground-axis-x">X</span>
          <span class="ground-axis ground-axis-y">Y</span>
          <span class="ground-axis ground-axis-z">Z</span>
        </div>
        <span class="origin-marker">origin</span>
        <span class="ground-plane-badge">${artifact.groundplane_calibration ? "ChArUco ground plane" : "Camera 0 origin"}</span>
        ${cameraMarkers}
      </div>
      <dl class="calibration-facts">
        <div>
          <dt>Status</dt>
          <dd>Calibration successful</dd>
        </div>
        <div>
          <dt>Cameras</dt>
          <dd>${artifact.camera_count}</dd>
        </div>
        <div>
          <dt>Square</dt>
          <dd>${formatCalibrationValue(artifact.charuco_square_size, " mm")}</dd>
        </div>
        <div>
          <dt>File</dt>
          <dd>${artifact.toml_name}</dd>
        </div>
      </dl>
    </article>
  `;
}

function renderCalibrationPreview(shot) {
  const hasSyncedVideos = syncedVideoCount(shot) >= 2;
  renderCalibrationArtifact(shot);
  calibrationPreviewButton.disabled = !hasSyncedVideos;

  if (!hasSyncedVideos) {
    calibrationPreviewStatus.textContent = "Sync at least two videos before building an overlay preview.";
    calibrationPreviewPlayer.innerHTML = "";
    return;
  }

  if (shot.calibration_preview_ready) {
    calibrationPreviewButton.textContent = "Rebuild overlay";
    calibrationPreviewStatus.textContent = shot.status?.calibration_toml_check
      ? "Overlay includes solved calibration axes where camera data is available."
      : "Overlay shows detected ChArUco board features. Run calibration to add solved axes.";
    calibrationPreviewPlayer.innerHTML = renderCalibrationPreviewPlayer(shot);
    bindGroundPlaneFramePicker(calibrationPreviewPlayer);
    return;
  }

  calibrationPreviewButton.textContent = "Build overlay";
  calibrationPreviewStatus.textContent = "Build an overlay preview to inspect board detection in the synced videos.";
  calibrationPreviewPlayer.innerHTML = "";
}

function updateMotionStages(job, shot) {
  const progress = job?.type === "motion_capture" ? Number(job.progress) || 0 : 0;
  const hasData2d = Boolean(shot.motion_capture_artifact?.data2d || shot.status?.data2d_status_check);
  const hasData3d = Boolean(shot.motion_capture_artifact?.data3d || shot.status?.data3d_status_check);
  const hasCom = Boolean(shot.motion_capture_artifact?.center_of_mass || shot.status?.center_of_mass_data_status_check);
  const activeStages = new Set();
  if (progress >= 35 || hasData2d) activeStages.add("track");
  if (progress >= 60 || hasData3d) activeStages.add("triangulate");
  if (progress >= 82 || hasData3d) activeStages.add("postprocess");
  if (progress >= 95 || hasCom) activeStages.add("save");
  motionStage.querySelectorAll("[data-stage]").forEach((stage) => {
    stage.classList.toggle("is-active", activeStages.has(stage.dataset.stage));
  });
}

function renderMotionArtifact(shot) {
  const artifact = shot.motion_capture_artifact || {};
  if (!artifact.data2d && !artifact.data3d) {
    motionResultArtifact.innerHTML = `<div class="video-row muted">Run pose estimation to create FreeMoCap output data.</div>`;
    return;
  }

  const outputCount = artifact.all_output_files?.length || 0;
  motionResultArtifact.innerHTML = `
    <dl class="motion-facts">
      <div>
        <dt>2D data</dt>
        <dd>${artifact.data2d ? artifact.data2d.name : "Missing"}</dd>
      </div>
      <div>
        <dt>3D skeleton</dt>
        <dd>${artifact.data3d ? artifact.data3d.name : "Missing"}</dd>
      </div>
      <div>
        <dt>Body CSV</dt>
        <dd>${artifact.body_csv ? artifact.body_csv.name : "Missing"}</dd>
      </div>
      <div>
        <dt>Outputs</dt>
        <dd>${outputCount} file${outputCount === 1 ? "" : "s"}</dd>
      </div>
    </dl>
  `;
}

function renderPosePreview(shot) {
  const hasPose = Boolean(shot.status?.data3d_status_check || shot.motion_capture_artifact?.data3d);
  const hasAnnotatedVideos = (shot.pose_preview_videos || []).some((video) => video !== "side_by_side.mp4");
  posePreviewButton.disabled = !hasAnnotatedVideos;

  if (!hasPose && !hasAnnotatedVideos) {
    posePreviewStatus.textContent = "Run pose estimation before building a preview.";
    posePreviewPlayer.innerHTML = "";
    return;
  }

  if (shot.pose_preview_ready) {
    posePreviewButton.textContent = "Rebuild preview";
    posePreviewStatus.textContent = "Preview uses FreeMoCap annotated videos from the pose estimation run.";
    posePreviewPlayer.innerHTML = renderPosePreviewPlayer(shot);
    return;
  }

  posePreviewButton.textContent = "Build preview";
  posePreviewStatus.textContent = hasAnnotatedVideos
    ? "Build a side-by-side player from FreeMoCap annotated videos."
    : "Waiting for FreeMoCap annotated videos.";
  posePreviewPlayer.innerHTML = "";
}

function renderPose3d(shot) {
  const hasPose = Boolean(shot.status?.data3d_status_check || shot.motion_capture_artifact?.data3d);
  if (!hasPose) {
    if (pose3dViewer.__pose3dCleanup) {
      pose3dViewer.__pose3dCleanup();
      pose3dViewer.__pose3dCleanup = null;
    }
    pose3dViewer.innerHTML = `<div class="video-row muted">Run pose estimation to inspect the 3D skeleton.</div>`;
    return;
  }

  mountPose3dViewer(pose3dViewer, pose3dUrl(shot));
}

function renderMotionWorkbench(shot) {
  const job = shot.latest_job;
  const runningMotion = job?.type === "motion_capture" && ["queued", "running"].includes(job.state);
  const hasCalibration = Boolean(shot.status?.calibration_toml_check) || syncedVideoCount(shot) === 1;
  const hasData3d = Boolean(shot.status?.data3d_status_check || shot.motion_capture_artifact?.data3d);
  const ready = canRunMotionCapture(shot);

  motionButton.disabled = !ready;
  renderMotionArtifact(shot);

  if (runningMotion) {
    motionState.textContent = `${job.progress}%`;
    motionStatus.textContent = job.message;
  } else if (hasData3d) {
    motionState.textContent = "Pose ready";
    motionStatus.textContent = "FreeMoCap pose outputs are saved in output_data.";
  } else if (syncedVideoCount(shot) < 1) {
    motionState.textContent = "Needs sync";
    motionStatus.textContent = "Sync videos before pose estimation.";
  } else if (!hasCalibration) {
    motionState.textContent = "Needs calibration";
    motionStatus.textContent = "Run calibration before multi-camera pose estimation.";
  } else {
    motionState.textContent = "Ready";
    motionStatus.textContent = "Runs FreeMoCap MediaPipe tracking, triangulation, and post-processing.";
  }

  updateMotionStages(job, shot);
  renderPose3d(shot);
  renderPosePreview(shot);
}

function waitForVideoMetadata(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("error", onError);
    };
    const onLoadedMetadata = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(video.error || new Error("Video failed to load."));
    };
    video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.load();
  });
}

function setupLinkedPlayer() {
  const player = selectedShotVideos.querySelector("[data-linked-player]");
  if (!player) return;

  const videos = Array.from(player.querySelectorAll("video"));
  const playButton = player.querySelector("[data-linked-play]");
  const seek = player.querySelector("[data-linked-seek]");
  const time = player.querySelector("[data-linked-time]");
  const status = player.querySelector("[data-linked-status]");
  let duration = 0;
  let seeking = false;
  let syncing = false;
  let requestedPlaying = false;

  const syncTo = (seconds) => {
    syncing = true;
    videos.forEach((video) => {
      if (Number.isFinite(video.duration)) {
        video.currentTime = Math.min(seconds, video.duration);
      }
    });
    syncing = false;
  };

  const updateDuration = () => {
    const durations = videos.map((video) => video.duration).filter(Number.isFinite);
    duration = durations.length ? Math.min(...durations) : 0;
    time.textContent = `0:00 / ${formatTime(duration)}`;
  };

  const updateProgress = () => {
    if (!duration || seeking) return;
    const currentTime = videos[0]?.currentTime || 0;
    seek.value = String(Math.round((currentTime / duration) * 1000));
    time.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;

    if (requestedPlaying && !syncing) {
      videos.slice(1).forEach((video) => {
        if (Math.abs(video.currentTime - currentTime) > 0.12) {
          video.currentTime = currentTime;
        }
      });
    }
  };

  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle("error", isError);
  };

  videos.forEach((video) => {
    video.muted = true;
    video.addEventListener("loadedmetadata", updateDuration);
    video.addEventListener("timeupdate", updateProgress);
    video.addEventListener("error", () => {
      setStatus(`Clip failed to load: ${video.error?.code || "unknown error"}`, true);
    });
  });

  seek.addEventListener("input", () => {
    seeking = true;
    const seconds = duration * (Number(seek.value) / 1000);
    time.textContent = `${formatTime(seconds)} / ${formatTime(duration)}`;
  });

  seek.addEventListener("change", () => {
    const seconds = duration * (Number(seek.value) / 1000);
    syncTo(seconds);
    seeking = false;
  });

  playButton.addEventListener("click", async () => {
    if (requestedPlaying) {
      requestedPlaying = false;
      videos.forEach((video) => video.pause());
      playButton.textContent = "Play";
      setStatus("");
      return;
    }

    playButton.disabled = true;
    playButton.textContent = "Starting";
    setStatus("Loading synced clips...");

    try {
      await Promise.all(videos.map(waitForVideoMetadata));
      updateDuration();
      syncTo(videos[0]?.currentTime || 0);
      const results = await Promise.allSettled(
        videos.map(async (video) => {
          video.muted = true;
          await video.play();
          return video;
        }),
      );
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      if (!fulfilled.length) {
        throw rejected[0]?.reason || new Error("Playback failed.");
      }
      requestedPlaying = true;
      playButton.textContent = "Pause";
      if (rejected.length) {
        setStatus(`${fulfilled.length} of ${videos.length} clips started. ${rejected[0].reason?.message || "One clip did not play."}`, true);
      } else {
        setStatus("");
      }
    } catch (error) {
      requestedPlaying = false;
      videos.forEach((video) => video.pause());
      playButton.textContent = "Play";
      setStatus(error?.message || "Playback failed.", true);
    } finally {
      playButton.disabled = false;
    }
  });
}

async function ensureBrowserPreviews(shot) {
  if ((shot.browser_preview_ready && shot.side_by_side_video) || !shot.videos.length) return;
  selectedShotVideos.innerHTML = `<div class="video-row muted">Preparing browser playback preview...</div>`;
  try {
    await api(`/api/shots/${encodeURIComponent(shot.id)}/browser-previews?force=true`, { method: "POST" });
    await refresh();
  } catch (error) {
    selectedShotVideos.innerHTML = `<div class="video-row muted">${error.message}</div>`;
  }
}

function selectCreateShot() {
  activeView = "create";
  selectedShotId = null;
  createShotPanel.classList.remove("is-hidden");
  shotDetailPanel.classList.add("is-hidden");
  createShotNav.classList.add("active");
  renderSidebarShots(recordingsCache);
  recordingName.focus();
}

function selectShot(shotId) {
  activeView = "detail";
  if (selectedShotId !== shotId) {
    activeDetailTab = "calibration";
  }
  selectedShotId = shotId;
  createShotPanel.classList.add("is-hidden");
  shotDetailPanel.classList.remove("is-hidden");
  createShotNav.classList.remove("active");
  renderSidebarShots(recordingsCache);
  renderSelectedShot();
}

function renderSidebarShots(recordings) {
  if (!recordings.length) {
    sidebarShotsList.innerHTML = `<a class="sidebar-empty-shot" href="#new-shot" data-create-shot>Create first shot</a>`;
    return;
  }

  sidebarShotsList.innerHTML = recordings
    .map((recording) => {
      const state = shotState(recording);
      const selectedClass = recording.id === selectedShotId ? "is-selected" : "";
      return `
        <a class="sidebar-shot ${selectedClass}" href="#shot-${recording.id}" data-shot-id="${recording.id}">
          <span>
            <strong>${recording.name}</strong>
            <small>${purposeLabel(recording.purpose)}</small>
          </span>
          <em class="${state.className}">${state.text}</em>
        </a>
      `;
    })
    .join("");
}

function renderSelectedShot() {
  const shot = recordingsCache.find((recording) => recording.id === selectedShotId);
  if (!shot) {
    if (recordingsCache.length) {
      selectShot(recordingsCache[0].id);
    } else {
      selectCreateShot();
    }
    return;
  }

  const state = shotState(shot);
  const job = shot.latest_job;
  selectedShotName.textContent = shot.name;
  selectedShotPurpose.textContent = purposeLabel(shot.purpose);
  selectedShotState.textContent = state.text;
  selectedShotVideoCount.textContent = `${shot.video_count} MP4 file${shot.video_count === 1 ? "" : "s"}`;
  selectedShotVideos.innerHTML = renderSideBySidePlayer(shot);
  bindGroundPlaneFramePicker(selectedShotVideos);
  setupLinkedPlayer();
  ensureBrowserPreviews(shot);
  renderCalibrationWorkbench(shot);
  renderMotionWorkbench(shot);
  showDetailTab(activeDetailTab);

  if (!job) {
    activeJobId = null;
    setDetailProgress(0, "No job", "This shot does not have a sync job yet.");
    setDetailLog(shot.name, "No job has been started.");
    return;
  }

  activeJobId = ["queued", "running"].includes(job.state) ? job.id : null;
  setDetailProgress(job.progress, jobTitle(job), job.message);
  setDetailLog(`${shot.name}: ${job.type} ${job.state}`, job.message);
}

function renderRecordings(recordings) {
  recordingsCache = recordings;
  appShell.classList.toggle("no-shots", recordings.length === 0);
  renderSidebarShots(recordings);

  const runningJob = recordings.find((recording) => ["queued", "running"].includes(recording.latest_job?.state));
  activeJobId = runningJob?.latest_job?.id || activeJobId;

  if (selectedShotId) {
    renderSelectedShot();
  } else if (recordings.length && activeView === "create") {
    renderSidebarShots(recordings);
  } else if (recordings.length) {
    selectShot(recordings[0].id);
  } else {
    selectCreateShot();
  }
}

async function refresh() {
  const [{ project }, system, recordings] = await Promise.all([
    api("/api/project"),
    api("/api/system"),
    api("/api/recordings"),
  ]);
  renderProject(project);
  if (!project.is_created) {
    showProjectOnboarding();
    return;
  }
  showApp();
  renderSystem(system);
  renderRecordings(recordings.recordings);
  if (activeJobId && !pollTimer) {
    pollTimer = setInterval(() => {
      pollJob(activeJobId).catch((error) => {
        clearInterval(pollTimer);
        pollTimer = null;
        syncStatus.innerHTML = `<span class="error">${error.message}</span>`;
        setBusy(false);
      });
    }, 900);
  }
}

async function pollJob(jobId) {
  const { job } = await api(`/api/jobs/${jobId}`);
  activeJobId = job.id;
  if (job.shot_id) {
    selectedShotId = job.shot_id;
  }
  setCreateProgress(job.progress, jobTitle(job), job.message);
  setCreateLog(`${job.recording_name || "Shot"}: ${job.state}`, job.message);
  setDetailProgress(job.progress, jobTitle(job), job.message);
  setDetailLog(`${job.recording_name || "Shot"}: ${job.type} ${job.state}`, job.message);

  if (job.state === "complete") {
    clearInterval(pollTimer);
    pollTimer = null;
    if (job.type === "sync") {
      syncStatus.textContent = "Synchronized.";
      recordingName.value = defaultRecordingName();
      fileInput.value = "";
      renderVideos();
      setBusy(false);
    } else if (job.type === "calibration") {
      calibrationStatus.textContent = job.message;
    } else if (job.type === "motion_capture") {
      motionStatus.textContent = job.message;
    }
    activeJobId = null;
    await refresh();
    return;
  }

  if (job.state === "failed") {
    clearInterval(pollTimer);
    pollTimer = null;
    if (job.type === "calibration") {
      calibrationStatus.innerHTML = `<span class="error">${job.message}</span>`;
    } else if (job.type === "motion_capture") {
      motionStatus.innerHTML = `<span class="error">${job.message}</span>`;
    } else {
      syncStatus.innerHTML = `<span class="error">${job.message}</span>`;
    }
    activeJobId = null;
    await refresh();
    setBusy(false);
  }
}

createProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(createProjectForm);
  const { project } = await api("/api/project", { method: "POST", body: data });
  renderProject(project);
  showApp();
  await refresh();
  selectCreateShot();
});

createShotNav.addEventListener("click", (event) => {
  event.preventDefault();
  selectCreateShot();
});

sidebarShotsList.addEventListener("click", (event) => {
  const createLink = event.target.closest("[data-create-shot]");
  if (createLink) {
    event.preventDefault();
    selectCreateShot();
    return;
  }

  const shotLink = event.target.closest("[data-shot-id]");
  if (!shotLink) return;
  event.preventDefault();
  selectShot(shotLink.dataset.shotId);
});

recordingName.value = defaultRecordingName();
fileInput.addEventListener("change", renderVideos);
refreshButton.addEventListener("click", refresh);
detailRefreshButton.addEventListener("click", refresh);
detailTabButtons.forEach((button) => {
  button.addEventListener("click", () => showDetailTab(button.dataset.detailTab));
});
pickGroundPlaneFrameButton.addEventListener("click", pickGroundPlaneFrameFromPlayer);

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, () => dropzone.classList.remove("dragover"));
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const videos = selectedVideos();
  if (videos.length < 1) {
    syncStatus.innerHTML = `<span class="error">Select one or more MP4 files.</span>`;
    return;
  }

  const data = new FormData();
  data.append("recording_name", recordingName.value);
  data.append("purpose", document.querySelector('input[name="purpose"]:checked').value);
  data.append("synchronization_method", document.querySelector("#syncMethod").value);
  data.append("brightness_threshold", document.querySelector("#brightnessThreshold").value);
  videos.forEach((file) => data.append("files", file, file.name));

  clearInterval(pollTimer);
  pollTimer = null;
  jobConsole.classList.remove("is-hidden");
  syncStatus.textContent = "";
  setCreateProgress(10, "Uploading", `Uploading ${videos.length} selected videos.`);
  setCreateLog(`${videos.length} source videos selected`, "Uploading to FreeMoCap Web");
  setBusy(true);

  try {
    const { job } = await api("/api/sync-jobs", { method: "POST", body: data });
    activeJobId = job.id;
    selectedShotId = job.shot_id;
    activeView = "detail";
    createShotPanel.classList.add("is-hidden");
    shotDetailPanel.classList.remove("is-hidden");
    setDetailProgress(job.progress, "Queued", job.message);
    setDetailLog(`${job.recording_name}: queued`, job.message);
    pollTimer = setInterval(() => {
      pollJob(job.id).catch((error) => {
        clearInterval(pollTimer);
        pollTimer = null;
        syncStatus.innerHTML = `<span class="error">${error.message}</span>`;
        setBusy(false);
      });
    }, 900);
    await refresh();
    await pollJob(job.id);
  } catch (error) {
    syncStatus.innerHTML = `<span class="error">${error.message}</span>`;
    setCreateProgress(100, "Failed", error.message);
    setBusy(false);
  }
});

calibrationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const shot = recordingsCache.find((recording) => recording.id === selectedShotId);
  if (!shot) return;
  if (!canRunCalibration(shot)) {
    calibrationStatus.innerHTML = `<span class="error">Sync at least two videos before calibration.</span>`;
    return;
  }

  const data = new FormData();
  data.append("charuco_board_name", charucoBoardName.value);
  data.append("charuco_square_size_mm", charucoSquareSize.value);
  data.append("use_charuco_as_groundplane", useCharucoGroundplane.checked ? "true" : "false");
  data.append("ground_plane_frame", groundPlaneFrame.value || "0");

  clearInterval(pollTimer);
  pollTimer = null;
  calibrationButton.disabled = true;
  calibrationStatus.textContent = "Queued FreeMoCap calibration.";
  setDetailProgress(10, "Queued", "Queued FreeMoCap calibration.");
  setDetailLog(`${shot.name}: calibration queued`, "Waiting for FreeMoCap calibration.");
  updateCalibrationStages({ type: "calibration", progress: 10 }, shot);

  try {
    const { job } = await api(`/api/shots/${encodeURIComponent(shot.id)}/calibration-jobs`, {
      method: "POST",
      body: data,
    });
    activeJobId = job.id;
    pollTimer = setInterval(() => {
      pollJob(job.id).catch((error) => {
        clearInterval(pollTimer);
        pollTimer = null;
        calibrationStatus.innerHTML = `<span class="error">${error.message}</span>`;
      });
    }, 900);
    await refresh();
    await pollJob(job.id);
  } catch (error) {
    calibrationStatus.innerHTML = `<span class="error">${error.message}</span>`;
    await refresh();
  }
});

motionButton.addEventListener("click", async () => {
  const shot = recordingsCache.find((recording) => recording.id === selectedShotId);
  if (!shot) return;
  if (!canRunMotionCapture(shot)) {
    motionStatus.innerHTML = `<span class="error">Sync and calibrate this shot before pose estimation.</span>`;
    return;
  }

  const data = new FormData();
  data.append("minimum_cameras_for_triangulation", syncedVideoCount(shot) >= 2 ? "2" : "1");

  clearInterval(pollTimer);
  pollTimer = null;
  motionButton.disabled = true;
  motionStatus.textContent = "Queued FreeMoCap pose estimation.";
  setDetailProgress(10, "Queued", "Queued FreeMoCap pose estimation.");
  setDetailLog(`${shot.name}: pose estimation queued`, "Waiting for FreeMoCap pose estimation.");
  updateMotionStages({ type: "motion_capture", progress: 10 }, shot);

  try {
    const { job } = await api(`/api/shots/${encodeURIComponent(shot.id)}/motion-capture-jobs`, {
      method: "POST",
      body: data,
    });
    activeJobId = job.id;
    pollTimer = setInterval(() => {
      pollJob(job.id).catch((error) => {
        clearInterval(pollTimer);
        pollTimer = null;
        motionStatus.innerHTML = `<span class="error">${error.message}</span>`;
      });
    }, 1200);
    await refresh();
    await pollJob(job.id);
  } catch (error) {
    motionStatus.innerHTML = `<span class="error">${error.message}</span>`;
    await refresh();
  }
});

posePreviewButton.addEventListener("click", async () => {
  const shot = recordingsCache.find((recording) => recording.id === selectedShotId);
  if (!shot) return;

  posePreviewButton.disabled = true;
  posePreviewStatus.textContent = "Building annotated pose preview.";
  posePreviewPlayer.innerHTML = `<div class="video-row muted">Combining FreeMoCap annotated videos...</div>`;

  try {
    await api(`/api/shots/${encodeURIComponent(shot.id)}/pose-preview?force=true`, {
      method: "POST",
    });
    await refresh();
    showDetailTab("pose-result");
  } catch (error) {
    posePreviewStatus.innerHTML = `<span class="error">${error.message}</span>`;
    posePreviewPlayer.innerHTML = "";
    posePreviewButton.disabled = false;
  }
});

calibrationPreviewButton.addEventListener("click", async () => {
  const shot = recordingsCache.find((recording) => recording.id === selectedShotId);
  if (!shot) return;
  if (syncedVideoCount(shot) < 2) {
    calibrationPreviewStatus.innerHTML = `<span class="error">Sync at least two videos before building an overlay preview.</span>`;
    return;
  }

  calibrationPreviewButton.disabled = true;
  calibrationPreviewStatus.textContent = "Building calibration overlay preview. This can take a minute.";
  calibrationPreviewPlayer.innerHTML = `<div class="video-row muted">Rendering ChArUco overlays...</div>`;

  try {
    const frame = encodeURIComponent(groundPlaneFrame.value || "0");
    await api(`/api/shots/${encodeURIComponent(shot.id)}/calibration-preview?force=true&ground_plane_frame=${frame}`, {
      method: "POST",
    });
    await refresh();
  } catch (error) {
    calibrationPreviewStatus.innerHTML = `<span class="error">${error.message}</span>`;
    calibrationPreviewPlayer.innerHTML = "";
    calibrationPreviewButton.disabled = false;
  }
});

renderVideos();
refresh().catch((error) => {
  systemStatus.textContent = error.message;
});
