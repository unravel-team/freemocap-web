import { mountPose3dViewer } from "./pose3d.js";
import { mountCalibration3dViewer } from "./calibration3d.js";

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
const shotActivity = document.querySelector("#shotActivity");
const selectedShotPurpose = document.querySelector("#selectedShotPurpose");
const selectedShotState = document.querySelector("#selectedShotState");
const selectedShotVideoCount = document.querySelector("#selectedShotVideoCount");
const selectedShotVideos = document.querySelector("#selectedShotVideos");
const syncJobProgress = document.querySelector("#syncJobProgress");
const calibrationJobProgress = document.querySelector("#calibrationJobProgress");
const motionJobProgress = document.querySelector("#motionJobProgress");
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
const groundPlanePicker = document.querySelector("#groundPlanePicker");
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
let activeDetailTab = "sync";
let detailTabTouched = false;
const SHOT_UI_STORAGE_PREFIX = "freemocap-web-shot-ui:";

function shotUiStateKey(shotId) {
  return `${SHOT_UI_STORAGE_PREFIX}${shotId}`;
}

function loadShotUiState(shotId) {
  if (!shotId) return {};
  try {
    return JSON.parse(localStorage.getItem(shotUiStateKey(shotId)) || "{}");
  } catch {
    return {};
  }
}

function saveShotUiState(shotId, patch) {
  if (!shotId) return;
  const nextState = { ...loadShotUiState(shotId), ...patch };
  localStorage.setItem(shotUiStateKey(shotId), JSON.stringify(nextState));
}

function applyShotUiState(shot) {
  const state = loadShotUiState(shot.id);
  if (state.calibration) {
    if (state.calibration.charucoBoardName) charucoBoardName.value = state.calibration.charucoBoardName;
    if (state.calibration.charucoSquareSize) charucoSquareSize.value = state.calibration.charucoSquareSize;
    groundPlaneFrame.value = state.calibration.groundPlaneFrame ?? groundPlaneFrame.value;
    useCharucoGroundplane.checked = state.calibration.groundPlaneMode === "charuco";
    const cameraGroundPlane = calibrationForm.querySelector('input[name="ground_plane_mode"][value="camera"]');
    if (cameraGroundPlane) {
      cameraGroundPlane.checked = state.calibration.groundPlaneMode !== "charuco";
    }
  }
}

function persistCalibrationUiState() {
  if (!selectedShotId) return;
  saveShotUiState(selectedShotId, {
    calibration: {
      charucoBoardName: charucoBoardName.value,
      charucoSquareSize: charucoSquareSize.value,
      groundPlaneMode: useCharucoGroundplane.checked ? "charuco" : "camera",
      groundPlaneFrame: groundPlaneFrame.value,
    },
  });
}

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

function showDetailTab(tabName) {
  activeDetailTab = tabName;
  if (selectedShotId) {
    saveShotUiState(selectedShotId, { activeDetailTab: tabName });
  }
  detailTabButtons.forEach((button) => {
    const selected = button.dataset.detailTab === tabName;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
  detailTabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.detailTabPanel !== tabName;
  });
  if (tabName === "pose-result" || tabName === "sync") {
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }
}

function hasRunningJob(shot) {
  return ["queued", "running"].includes(shot.latest_job?.state);
}

function tabStatus(text, className = "") {
  return { text, className };
}

function workflowTabStates(shot) {
  const job = shot.latest_job;
  const running = hasRunningJob(shot);
  const hasSync = syncedVideoCount(shot) >= 1 || Boolean(shot.status?.synchronized_videos_status_check);
  const hasMultiCamSync = syncedVideoCount(shot) >= 2;
  const hasCalibration = Boolean(shot.status?.calibration_toml_check);
  const hasPose = Boolean(shot.status?.data3d_status_check || shot.motion_capture_artifact?.data3d);

  const states = {
    sync: hasSync ? tabStatus("Done", "is-done") : tabStatus("Needed", "is-needed"),
    calibration: hasMultiCamSync ? tabStatus("Pending", "is-ready") : tabStatus("Blocked", "is-blocked"),
    "calibration-result": hasCalibration ? tabStatus("Ready", "is-done") : tabStatus("Pending", "is-muted"),
    pose: hasCalibration || syncedVideoCount(shot) === 1 ? tabStatus("Pending", "is-ready") : tabStatus("Blocked", "is-blocked"),
    "pose-result": hasPose ? tabStatus("Ready", "is-done") : tabStatus("Pending", "is-muted"),
  };

  if (job?.type === "manual_resync" && ["queued", "running"].includes(job.state)) {
    return {
      sync: tabStatus(`${job.progress}%`, "is-running"),
      calibration: tabStatus("Resetting", "is-muted"),
      "calibration-result": tabStatus("Resetting", "is-muted"),
      pose: tabStatus("Resetting", "is-muted"),
      "pose-result": tabStatus("Resetting", "is-muted"),
    };
  }

  if (job?.type === "manual_resync" && job.state === "complete") {
    return {
      sync: tabStatus("Done", "is-done"),
      calibration: hasMultiCamSync ? tabStatus("Pending", "is-ready") : tabStatus("Blocked", "is-blocked"),
      "calibration-result": tabStatus("Pending", "is-muted"),
      pose: syncedVideoCount(shot) === 1 ? tabStatus("Pending", "is-ready") : tabStatus("Blocked", "is-blocked"),
      "pose-result": tabStatus("Pending", "is-muted"),
    };
  }

  if (hasCalibration) {
    states.calibration = tabStatus("Done", "is-done");
  }
  if (hasPose) {
    states.pose = tabStatus("Done", "is-done");
  }
  if (shot.calibration_preview_ready) {
    states["calibration-result"] = tabStatus("Preview", "is-done");
  }
  if (shot.pose_preview_ready) {
    states["pose-result"] = tabStatus("Preview", "is-done");
  }
  if (job?.state === "failed") {
    const failedTab = job.type === "calibration" ? "calibration" : job.type === "motion_capture" ? "pose" : "sync";
    states[failedTab] = tabStatus("Failed", "is-failed");
  }
  if (running) {
    const runningTab = job.type === "calibration" ? "calibration" : job.type === "motion_capture" ? "pose" : "sync";
    states[runningTab] = tabStatus(`${job.progress}%`, "is-running");
  }

  return states;
}

function relevantTabForShot(shot) {
  const job = shot.latest_job;
  const hasSync = syncedVideoCount(shot) >= 1 || Boolean(shot.status?.synchronized_videos_status_check);
  const hasCalibration = Boolean(shot.status?.calibration_toml_check);
  const hasPose = Boolean(shot.status?.data3d_status_check || shot.motion_capture_artifact?.data3d);

  if (["queued", "running"].includes(job?.state)) {
    if (job.type === "calibration") return "calibration";
    if (job.type === "motion_capture") return "pose";
    return "sync";
  }
  if (job?.state === "failed") {
    if (job.type === "calibration") return "calibration";
    if (job.type === "motion_capture") return "pose";
    return "sync";
  }
  if (job?.state === "complete" && job.type === "manual_resync") return "sync";
  if (hasPose) return "pose-result";
  if (hasCalibration) return "calibration-result";
  if (hasSync) return "calibration";
  return "sync";
}

function updateDetailTabs(shot) {
  const labels = {
    sync: "Sync",
    calibration: "Calibration",
    "calibration-result": "Calibration result",
    pose: "Pose estimation",
    "pose-result": "Pose result",
  };
  const states = workflowTabStates(shot);

  detailTabButtons.forEach((button) => {
    const tabName = button.dataset.detailTab;
    const state = states[tabName] || tabStatus("", "");
    button.innerHTML = `
      <span>${labels[tabName]}</span>
      <em class="${state.className}">${state.text}</em>
    `;
  });
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
  if (job?.state === "invalidated") return { className: "", text: hasVideos ? "Synced" : "Draft" };
  if (["queued", "running"].includes(job?.state)) {
    if (job.type === "calibration") return { className: "pending", text: `Cal ${job.progress}%` };
    if (job.type === "motion_capture") return { className: "pending", text: `Pose ${job.progress}%` };
    if (job.type === "manual_resync") return { className: "pending", text: `Resync ${job.progress}%` };
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
  if (job.state === "invalidated") return "Reset";
  if (job.state === "queued") return "Queued";
  if (job.type === "calibration") return "Calibrating";
  if (job.type === "motion_capture") return "Estimating pose";
  if (job.type === "manual_resync") return "Resyncing";
  return "Syncing";
}

function jobStep(job) {
  if (!job) return null;
  if (job.type === "calibration") return "calibration";
  if (job.type === "motion_capture") return "pose";
  if (job.type === "sync" || job.type === "manual_resync") return "sync";
  return null;
}

function isActiveJob(job) {
  return ["queued", "running"].includes(job?.state);
}

function renderStepProgress(panel, job, step) {
  if (!panel) return;
  const active = isActiveJob(job) && jobStep(job) === step;
  panel.hidden = !active;
  if (!active) {
    panel.innerHTML = "";
    return;
  }

  const safeProgress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  panel.innerHTML = `
    <div class="progress-panel" aria-live="polite">
      <div class="progress-header">
        <strong>${jobTitle(job)}</strong>
        <span>${safeProgress}%</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:${safeProgress}%"></div>
      </div>
      <div class="progress-message">${job.message}</div>
    </div>
  `;
}

function renderStepProgressPanels(shot) {
  const job = shot.latest_job;
  renderStepProgress(syncJobProgress, job, "sync");
  renderStepProgress(calibrationJobProgress, job, "calibration");
  renderStepProgress(motionJobProgress, job, "pose");
}

function renderShotActivity(shot) {
  const job = shot.latest_job;
  if (!job) {
    shotActivity.textContent = "No job activity yet";
    shotActivity.className = "shot-activity";
    return;
  }

  const running = isActiveJob(job);
  const title = running ? `Running: ${jobTitle(job)} ${job.progress}%` : `Latest activity: ${jobTitle(job)}`;
  shotActivity.textContent = `${title}. ${job.message}`;
  shotActivity.className = `shot-activity ${running ? "is-running" : ""} ${job.state === "failed" ? "is-failed" : ""}`;
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

function renderGroundPlanePicker(shot) {
  const videos = (shot.browser_videos || []).filter((video) => video !== shot.side_by_side_video);
  if (!videos.length) {
    groundPlanePicker.innerHTML = `<div class="video-row muted">Sync videos before choosing a ground-plane frame.</div>`;
    return;
  }

  const state = loadShotUiState(shot.id);
  const selectedVideo = videos.includes(state.groundPlaneVideo) ? state.groundPlaneVideo : videos[0];
  const frame = state.calibration?.groundPlaneFrame ?? groundPlaneFrame.value ?? "0";
  groundPlanePicker.innerHTML = `
    <div class="ground-plane-picker-toolbar">
      <label>
        <span>Camera</span>
        <select data-ground-plane-video>
          ${videos.map((video, index) => `<option value="${video}" ${video === selectedVideo ? "selected" : ""}>Camera ${index + 1}</option>`).join("")}
        </select>
      </label>
      <label>
        <span>Frame</span>
        <input type="number" min="0" step="1" value="${frame}" data-ground-plane-frame-input />
      </label>
    </div>
    <video muted playsinline preload="metadata" poster="${posterUrl(shot, selectedVideo)}" src="${videoUrl(shot, selectedVideo)}" data-ground-plane-video-preview></video>
    <input class="frame-scrubber" type="range" min="0" max="0" step="1" value="${frame}" data-ground-plane-frame-scrubber aria-label="Ground-plane frame scrubber" />
  `;
  setupGroundPlanePicker(shot);
}

function setupGroundPlanePicker(shot) {
  const videoSelect = groundPlanePicker.querySelector("[data-ground-plane-video]");
  const video = groundPlanePicker.querySelector("[data-ground-plane-video-preview]");
  const frameInput = groundPlanePicker.querySelector("[data-ground-plane-frame-input]");
  const scrubber = groundPlanePicker.querySelector("[data-ground-plane-frame-scrubber]");
  if (!videoSelect || !video || !frameInput || !scrubber) return;

  const updateFrameLimit = () => {
    const fps = estimateShotFrameRate(shot, video);
    const maxFrame = Number.isFinite(video.duration) && video.duration > 0
      ? Math.max(0, Math.floor(video.duration * fps) - 1)
      : 0;
    scrubber.max = String(maxFrame);
    frameInput.max = String(maxFrame);
    return maxFrame;
  };

  const setFrame = async (frame) => {
    await waitForVideoMetadata(video).catch(() => {});
    const maxFrame = updateFrameLimit();
    const safeFrame = Math.max(0, Math.min(maxFrame, Math.round(Number(frame) || 0)));
    const fps = estimateShotFrameRate(shot, video);
    frameInput.value = String(safeFrame);
    scrubber.value = String(safeFrame);
    groundPlaneFrame.value = String(safeFrame);
    video.currentTime = safeFrame / fps;
    useCharucoGroundplane.checked = true;
    saveShotUiState(shot.id, { groundPlaneVideo: videoSelect.value });
    persistCalibrationUiState();
  };

  video.addEventListener("loadedmetadata", () => {
    setFrame(frameInput.value);
  });
  videoSelect.addEventListener("change", () => {
    saveShotUiState(shot.id, { groundPlaneVideo: videoSelect.value });
    renderGroundPlanePicker(shot);
  });
  frameInput.addEventListener("input", () => {
    setFrame(frameInput.value);
  });
  scrubber.addEventListener("input", () => {
    setFrame(scrubber.value);
  });
  video.addEventListener("timeupdate", () => {
    lastGroundPlaneVideo = video;
  });
  setFrame(frameInput.value);
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
  renderGroundPlanePicker(shot);
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
  const manualResync = renderManualResyncPanel(shot);
  if (shot.side_by_side_video) {
    return `
      <article class="combined-player">
        <video controls playsinline preload="metadata" poster="${posterUrl(shot, shot.side_by_side_video)}" src="${videoUrl(shot, shot.side_by_side_video)}"></video>
        <div>
          <strong>Synced side-by-side preview</strong>
          <span>${shot.video_count} synced clips in one browser player</span>
        </div>
      </article>
      ${manualResync}
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
    ${manualResync}
  `;
}

function renderManualResyncPanel(shot) {
  const playableVideos = (shot.browser_videos || []).filter((video) => video !== shot.side_by_side_video);
  if (playableVideos.length < 2) {
    return "";
  }
  const uiState = loadShotUiState(shot.id);
  const resyncOffsets = uiState.resyncOffsets || {};
  const resyncBaseFrame = uiState.resyncBaseFrame || "0";

  const videoMarkup = playableVideos
    .map(
      (video, index) => `
        <article class="resync-camera" data-resync-camera>
          <video muted playsinline preload="metadata" poster="${posterUrl(shot, video)}" src="${videoUrl(shot, video)}" data-resync-video data-video-name="${video}"></video>
          <div class="resync-camera-controls">
            <strong>Camera ${index + 1}</strong>
            <span>${video}</span>
            <div class="frame-stepper">
              <button class="secondary" type="button" data-offset-step="-10">-10</button>
              <button class="secondary" type="button" data-offset-step="-1">-1</button>
              <input type="number" step="1" value="${resyncOffsets[video] || 0}" data-resync-offset data-video-name="${video}" aria-label="Frame offset for ${video}" />
              <button class="secondary" type="button" data-offset-step="1">+1</button>
              <button class="secondary" type="button" data-offset-step="10">+10</button>
            </div>
          </div>
        </article>
      `,
    )
    .join("");

  return `
    <section class="manual-resync" data-manual-resync>
      <div class="section-title-row">
        <h3>Frame resync</h3>
        <span>Manual offsets</span>
      </div>
      <div class="manual-resync-controls">
        <button class="secondary" type="button" data-resync-frame-step="-1">Previous frame</button>
        <label>
          <span>Preview frame</span>
          <input type="number" min="0" step="1" value="${resyncBaseFrame}" data-resync-base-frame />
        </label>
        <input class="frame-scrubber" type="range" min="0" max="0" value="${resyncBaseFrame}" step="1" data-resync-frame-scrubber aria-label="Preview frame scrubber" />
        <button class="secondary" type="button" data-resync-frame-step="1">Next frame</button>
      </div>
      <div class="resync-camera-grid">
        ${videoMarkup}
      </div>
      <div class="actions compact-actions">
        <button class="primary" type="button" data-apply-resync>Apply frame resync</button>
        <output data-resync-status>Offsets are in frames. Positive trims that camera forward; negative delays it.</output>
      </div>
    </section>
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
  calibrationResultArtifact.querySelector(".calibration3d-root")?.__calibration3dCleanup?.();
  if (!artifact) {
    calibrationResultArtifact.innerHTML = `<div class="video-row muted">Run calibration to create a camera layout artifact.</div>`;
    return;
  }

  calibrationResultArtifact.innerHTML = `
    <article class="calibration-artifact">
      <div class="calibration3d-root"></div>
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
  mountCalibration3dViewer(calibrationResultArtifact.querySelector(".calibration3d-root"), artifact);
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

function setupManualResync(shot) {
  const panel = selectedShotVideos.querySelector("[data-manual-resync]");
  if (!panel) return;

  const videos = Array.from(panel.querySelectorAll("[data-resync-video]"));
  const baseFrameInput = panel.querySelector("[data-resync-base-frame]");
  const frameScrubber = panel.querySelector("[data-resync-frame-scrubber]");
  const status = panel.querySelector("[data-resync-status]");
  const applyButton = panel.querySelector("[data-apply-resync]");
  const fps = 30;

  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle("error", isError);
  };

  const offsetInputs = () => Array.from(panel.querySelectorAll("[data-resync-offset]"));
  const persistResyncUiState = () => {
    const offsets = {};
    offsetInputs().forEach((input) => {
      offsets[input.dataset.videoName] = Number(input.value) || 0;
    });
    saveShotUiState(shot.id, {
      resyncBaseFrame: baseFrameInput.value,
      resyncOffsets: offsets,
    });
  };

  const updateFrameLimit = () => {
    const frameCounts = videos
      .filter((video) => Number.isFinite(video.duration) && video.duration > 0)
      .map((video) => Math.max(0, Math.floor(video.duration * fps) - 1));
    const maxFrame = frameCounts.length ? Math.min(...frameCounts) : 0;
    frameScrubber.max = String(maxFrame);
    baseFrameInput.max = String(maxFrame);
    if ((Number(baseFrameInput.value) || 0) > maxFrame) {
      baseFrameInput.value = String(maxFrame);
      frameScrubber.value = String(maxFrame);
    }
    return maxFrame;
  };

  const setBaseFrame = (frame) => {
    const maxFrame = Number(frameScrubber.max) || updateFrameLimit();
    const safeFrame = Math.max(0, Math.min(maxFrame, Math.round(Number(frame) || 0)));
    baseFrameInput.value = String(safeFrame);
    frameScrubber.value = String(safeFrame);
    persistResyncUiState();
  };

  const previewOffsets = async () => {
    await Promise.allSettled(videos.map(waitForVideoMetadata));
    updateFrameLimit();
    setBaseFrame(baseFrameInput.value);
    const baseFrame = Number(baseFrameInput.value) || 0;
    videos.forEach((video) => {
      const input = offsetInputs().find((candidate) => candidate.dataset.videoName === video.dataset.videoName);
      const offset = Number(input?.value) || 0;
      const targetFrame = Math.max(0, baseFrame + offset);
      const durationFrame = Number.isFinite(video.duration) ? Math.max(0, Math.floor(video.duration * fps) - 1) : targetFrame;
      video.currentTime = Math.min(targetFrame, durationFrame) / fps;
    });
  };

  panel.addEventListener("click", (event) => {
    const offsetButton = event.target.closest("[data-offset-step]");
    if (offsetButton) {
      const camera = offsetButton.closest("[data-resync-camera]");
      const input = camera?.querySelector("[data-resync-offset]");
      if (input) {
        input.value = String((Number(input.value) || 0) + Number(offsetButton.dataset.offsetStep));
        persistResyncUiState();
        previewOffsets().catch((error) => setStatus(error.message, true));
      }
      return;
    }

    const frameButton = event.target.closest("[data-resync-frame-step]");
    if (frameButton) {
      setBaseFrame((Number(baseFrameInput.value) || 0) + Number(frameButton.dataset.resyncFrameStep));
      previewOffsets().catch((error) => setStatus(error.message, true));
      return;
    }
  });

  baseFrameInput.addEventListener("input", () => {
    setBaseFrame(baseFrameInput.value);
    previewOffsets().catch((error) => setStatus(error.message, true));
  });
  frameScrubber.addEventListener("input", () => {
    setBaseFrame(frameScrubber.value);
    previewOffsets().catch((error) => setStatus(error.message, true));
  });
  offsetInputs().forEach((input) => {
    input.addEventListener("change", () => {
      persistResyncUiState();
      previewOffsets().catch((error) => setStatus(error.message, true));
    });
  });

  applyButton.addEventListener("click", async () => {
    const offsets = {};
    offsetInputs().forEach((input) => {
      offsets[input.dataset.videoName] = Number(input.value) || 0;
    });

    applyButton.disabled = true;
    setStatus("Queued manual frame resync. Calibration and pose outputs will be cleared.");
    shotActivity.textContent = "Running: Resyncing 10%. Queued manual frame resync.";
    shotActivity.className = "shot-activity is-running";
    activeDetailTab = "sync";
    detailTabTouched = false;

    try {
      const { job } = await api(`/api/shots/${encodeURIComponent(shot.id)}/manual-resync-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offsets }),
      });
      activeJobId = job.id;
      clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        pollJob(job.id).catch((error) => {
          clearInterval(pollTimer);
          pollTimer = null;
          setStatus(error.message, true);
        });
      }, 900);
      await refresh();
      await pollJob(job.id);
    } catch (error) {
      setStatus(error.message, true);
      applyButton.disabled = false;
    }
  });

  previewOffsets().catch(() => {});
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
    const shot = recordingsCache.find((recording) => recording.id === shotId);
    const savedTab = loadShotUiState(shotId).activeDetailTab;
    activeDetailTab = savedTab || (shot ? relevantTabForShot(shot) : "sync");
    detailTabTouched = Boolean(savedTab);
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
  applyShotUiState(shot);
  selectedShotVideos.innerHTML = renderSideBySidePlayer(shot);
  bindGroundPlaneFramePicker(selectedShotVideos);
  setupLinkedPlayer();
  setupManualResync(shot);
  ensureBrowserPreviews(shot);
  renderCalibrationWorkbench(shot);
  renderMotionWorkbench(shot);
  renderShotActivity(shot);
  renderStepProgressPanels(shot);
  if (!detailTabTouched || hasRunningJob(shot)) {
    activeDetailTab = relevantTabForShot(shot);
  }
  updateDetailTabs(shot);
  showDetailTab(activeDetailTab);

  activeJobId = ["queued", "running"].includes(job?.state) ? job.id : null;
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
  shotActivity.textContent = `${isActiveJob(job) ? "Running" : "Latest activity"}: ${jobTitle(job)} ${isActiveJob(job) ? `${job.progress}%` : ""}. ${job.message}`;
  shotActivity.className = `shot-activity ${isActiveJob(job) ? "is-running" : ""} ${job.state === "failed" ? "is-failed" : ""}`;

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
    detailTabTouched = false;
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
    detailTabTouched = false;
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
  button.addEventListener("click", () => {
    detailTabTouched = true;
    showDetailTab(button.dataset.detailTab);
  });
});
calibrationForm.querySelectorAll("input, select").forEach((field) => {
  field.addEventListener("change", persistCalibrationUiState);
});

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
    activeDetailTab = "sync";
    detailTabTouched = false;
    createShotPanel.classList.add("is-hidden");
    shotDetailPanel.classList.remove("is-hidden");
    shotActivity.textContent = `Running: Queued ${job.progress}%. ${job.message}`;
    shotActivity.className = "shot-activity is-running";
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
  activeDetailTab = "calibration";
  detailTabTouched = false;
  calibrationButton.disabled = true;
  calibrationStatus.textContent = "Queued FreeMoCap calibration.";
  shotActivity.textContent = "Running: Queued 10%. Queued FreeMoCap calibration.";
  shotActivity.className = "shot-activity is-running";
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
  activeDetailTab = "pose";
  detailTabTouched = false;
  motionButton.disabled = true;
  motionStatus.textContent = "Queued FreeMoCap pose estimation.";
  shotActivity.textContent = "Running: Queued 10%. Queued FreeMoCap pose estimation.";
  shotActivity.className = "shot-activity is-running";
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
