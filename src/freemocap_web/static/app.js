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
const syncMethod = document.querySelector("#syncMethod");
const localVideoPaths = document.querySelector("#localVideoPaths");
const deleteShotButton = document.querySelector("#deleteShotButton");
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
const calibrationStartTime = document.querySelector("#calibrationStartTime");
const calibrationEndTime = document.querySelector("#calibrationEndTime");
const useCharucoGroundplane = document.querySelector("#useCharucoGroundplane");
const groundPlaneFrame = document.querySelector("#groundPlaneFrame");
const groundPlanePicker = document.querySelector("#groundPlanePicker");
const calibrationPreviewButton = document.querySelector("#calibrationPreviewButton");
const calibrationPreviewStatus = document.querySelector("#calibrationPreviewStatus");
const calibrationPreviewPlayer = document.querySelector("#calibrationPreviewPlayer");
const calibrationResultArtifact = document.querySelector("#calibrationResultArtifact");
const motionState = document.querySelector("#motionState");
const motionStage = document.querySelector("#motionStage");
const motionOutputProgress = document.querySelector("#motionOutputProgress");
const motionInlineClips = document.querySelector("#motionInlineClips");
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
let selectedSourceVideos = [];
const FRAME_PREVIEW_REQUEST_BASE = Date.now() * 1000;
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
    calibrationStartTime.value = state.calibration.startTime ?? calibrationStartTime.value;
    calibrationEndTime.value = state.calibration.endTime ?? calibrationEndTime.value;
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
      startTime: calibrationStartTime.value,
      endTime: calibrationEndTime.value,
      groundPlaneMode: useCharucoGroundplane.checked ? "charuco" : "camera",
      groundPlaneFrame: groundPlaneFrame.value,
    },
  });
}

function defaultRecordingName() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "_");
  return `shot_${stamp}`;
}

function fileSelectionKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function addSelectedVideos(files) {
  const existingFiles = new Set(selectedSourceVideos.map(fileSelectionKey));
  const newVideos = Array.from(files || []).filter((file) => file.name.toLowerCase().endsWith(".mp4"));
  newVideos.forEach((file) => {
    const key = fileSelectionKey(file);
    if (!existingFiles.has(key)) {
      selectedSourceVideos.push(file);
      existingFiles.add(key);
    }
  });
}

function clearSelectedVideos() {
  selectedSourceVideos = [];
  fileInput.value = "";
  localVideoPaths.value = "";
}

function selectedVideos() {
  return selectedSourceVideos;
}

function selectedLocalVideoPaths() {
  return (localVideoPaths.value || "")
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
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
    "pose-result": hasPose ? tabStatus("Ready", "is-done") : annotatedPoseVideos(shot).length ? tabStatus("Clips ready", "is-ready") : tabStatus("Pending", "is-muted"),
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
  const localPaths = selectedLocalVideoPaths();
  const selectedSourceCount = videos.length + localPaths.length;
  const bytes = videos.reduce((total, file) => total + file.size, 0);
  const usesManualSync = syncMethod.value === "manual";
  appShell.classList.toggle("has-selection", selectedSourceCount > 0);

  if (selectedSourceCount >= 2) {
    syncButton.disabled = false;
    syncStatus.textContent = "";
    selectedVideoSummary.textContent = `${selectedSourceCount} videos selected`;
    setCreateProgress(
      0,
      "Ready",
      usesManualSync
        ? `Create manual alignment previews for these ${selectedSourceCount} videos.`
        : `Run Skelly sync when these ${selectedSourceCount} videos look right.`,
    );
    const localPathSummary = localPaths.length ? `${localPaths.length} local path${localPaths.length === 1 ? "" : "s"}` : formatSize(bytes);
    setCreateLog(`${selectedSourceCount} source videos selected`, `${localPathSummary} ready for ${usesManualSync ? "manual alignment" : "processing"}`);
  } else if (selectedSourceCount === 1) {
    syncButton.disabled = false;
    syncStatus.textContent = "";
    selectedVideoSummary.textContent = "1 video selected";
    setCreateProgress(0, "Ready", "Prepare this single-video shot for downstream processing.");
    setCreateLog("1 source video selected", localPaths.length ? "1 local path ready for processing" : `${formatSize(bytes)} ready for upload`);
  } else {
    syncButton.disabled = true;
    selectedVideoSummary.textContent = "Select videos";
    setCreateProgress(0, "Waiting for videos", "Select MP4 files or paste local paths to create a shot.");
    setCreateLog("Waiting for source videos", "Use files or local paths from the same shot");
  }
}

function setBusy(isBusy) {
  form.querySelectorAll("button, input, select, textarea").forEach((element) => {
    element.disabled = isBusy;
  });
  fileInput.disabled = isBusy;
  if (!isBusy) {
    syncButton.disabled = selectedVideos().length + selectedLocalVideoPaths().length < 1;
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
  if (job?.state === "failed" && job.type === "sync" && !hasVideos) return { className: "failed", text: "Sync failed" };
  if (job?.state === "failed" && job.type === "calibration" && !hasCalibration) return { className: "failed", text: "Cal failed" };
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

function setStatePill(element, text, state = "") {
  element.textContent = text;
  element.className = state ? `state-pill ${state}` : "state-pill";
}

function isActiveJob(job) {
  return ["queued", "running"].includes(job?.state);
}

function failedJobIsBlockingShot(shot) {
  const job = shot.latest_job;
  if (job?.state !== "failed") return false;
  if (job.type === "sync") return !shot.status?.synchronized_videos_status_check;
  if (job.type === "calibration") return !shot.status?.calibration_toml_check;
  return false;
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
  const title = job.state === "failed" && job.type === "motion_capture"
    ? "Last pose attempt failed"
    : running ? `Running: ${jobTitle(job)} ${job.progress}%` : `Latest activity: ${jobTitle(job)}`;
  shotActivity.textContent = `${title}. ${job.message}`;
  shotActivity.className = `shot-activity ${running ? "is-running" : ""} ${failedJobIsBlockingShot(shot) ? "is-failed" : ""}`;
}

function syncedVideoCount(shot) {
  return Number(shot.video_count) || 0;
}

function videoFilenameFromElement(video) {
  const source = video.currentSrc || video.src || "";
  if (!source) return video.dataset.videoName || "";
  try {
    return decodeURIComponent(new URL(source, window.location.href).pathname.split("/").pop() || "");
  } catch {
    return video.dataset.videoName || "";
  }
}

function synchronizedVideoFrameCount(shot, videoName) {
  const counts = shot.synchronized_video_frame_counts || shot.status?.video_and_camera_info?.number_of_frames_in_videos || {};
  const value = counts[videoName];
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function synchronizedVideoFps(shot, videoName) {
  const value = (shot.synchronized_video_fps || {})[videoName];
  const fps = Number(value);
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
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
  const videoName = videoFilenameFromElement(video);
  const mappedFps = synchronizedVideoFps(shot, videoName);
  if (mappedFps) return mappedFps;
  const frameCount = synchronizedVideoFrameCount(shot, videoName);
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
    const frameCount = synchronizedVideoFrameCount(shot, videoSelect.value);
    const fps = estimateShotFrameRate(shot, video);
    const maxFrame = frameCount
      ? Math.max(0, frameCount - 1)
      : Number.isFinite(video.duration) && video.duration > 0
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
    setStatePill(calibrationState, `${job.progress}%`, "is-running");
    calibrationStatus.textContent = job.message;
  } else if (hasCalibration) {
    setStatePill(calibrationState, "Calibrated", "is-done");
    calibrationStatus.textContent = shot.calibration_toml_name || "Camera calibration saved.";
  } else if (syncedVideoCount(shot) < 2) {
    setStatePill(calibrationState, "Needs synced videos", "is-muted");
    calibrationStatus.textContent = "Sync at least two videos before calibration.";
  } else {
    setStatePill(calibrationState, "Ready", "is-ready");
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

function posePreviewPosterName(filename) {
  return filename.replace(/\.mp4$/i, ".jpg");
}

function posePreviewPosterExists(shot, filename) {
  return (shot.pose_preview_posters || []).includes(posePreviewPosterName(filename));
}

function posePreviewPosterUrl(shot, filename) {
  const posterName = posePreviewPosterName(filename);
  return `/api/shots/${encodeURIComponent(shot.id)}/pose-preview-posters/${encodeURIComponent(posterName)}?v=${encodeURIComponent(posePreviewCacheKey(shot))}`;
}

function pose3dUrl(shot) {
  const dataKey = shot.motion_capture_artifact?.data3d?.size_bytes || shot.latest_job?.updated_at || posePreviewCacheKey(shot);
  return `/api/shots/${encodeURIComponent(shot.id)}/pose-3d?v=${encodeURIComponent(dataKey)}`;
}

function framePreviewUrl(shot, filename, frame, offset = 0, requestId = 0) {
  const params = new URLSearchParams({
    frame: String(Math.max(0, Math.round(Number(frame) || 0))),
    offset: String(Math.round(Number(offset) || 0)),
    v: String(mediaCacheKey(shot)),
    request_id: String(FRAME_PREVIEW_REQUEST_BASE + Math.max(0, Math.round(Number(requestId) || 0))),
  });
  return `/api/shots/${encodeURIComponent(shot.id)}/frame-previews/${encodeURIComponent(filename)}?${params.toString()}`;
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
  if (isManualAlignmentShot(shot)) {
    return manualResync || `<div class="video-row muted">No synchronized videos found</div>`;
  }

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
  const completedResync = completedManualResyncJob(shot);
  let uiState = loadShotUiState(shot.id);
  if (completedResync && uiState.reviewedResyncJobId !== completedResync.id) {
    uiState = {
      ...uiState,
      resyncBaseFrame: "0",
      resyncOffsets: {},
      reviewedResyncJobId: completedResync.id,
    };
    saveShotUiState(shot.id, {
      resyncBaseFrame: "0",
      resyncOffsets: {},
      reviewedResyncJobId: completedResync.id,
    });
  }
  const resyncOffsets = uiState.resyncOffsets || {};
  const resyncBaseFrame = uiState.resyncBaseFrame || "0";
  const useFrameImages = isManualAlignmentShot(shot);
  const reviewMarkup = completedResync
    ? `
      <div class="resync-review-callout">
        <strong>Resync applied</strong>
        <span>Offsets are reset for review. Step through frames below and confirm the cameras are aligned before calibration.</span>
        <button class="secondary" type="button" data-open-calibration>Go to Calibration</button>
      </div>
    `
    : "";

  const videoMarkup = playableVideos
    .map(
      (video, index) => `
        <article class="resync-camera" data-resync-camera>
          <video muted playsinline preload="metadata" poster="${posterUrl(shot, video)}" src="${videoUrl(shot, video)}" data-resync-video data-video-name="${video}" ${useFrameImages ? "hidden" : ""}></video>
          <img class="resync-frame-preview" alt="Frame preview for Camera ${index + 1}" data-resync-frame-preview data-video-name="${video}" ${useFrameImages ? "" : "hidden"} />
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
        <span>${completedResync ? "Review synced frames" : "Manual offsets"}</span>
      </div>
      ${reviewMarkup}
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

  const cameraVideos = (shot.calibration_preview_videos || []).filter((video) => video !== shot.calibration_side_by_side_video);
  const cameraMarkup = cameraVideos.length
    ? `
      <section class="inline-preview-section" aria-label="Calibration camera overlays">
        <div class="inline-preview-heading">
          <strong>Camera overlays</strong>
          <span>${cameraVideos.length} camera${cameraVideos.length === 1 ? "" : "s"}</span>
        </div>
        <div class="pose-clip-grid">
          ${cameraVideos
            .map((video, index) => `
              <article class="clip-card">
                <video controls playsinline preload="metadata" poster="${calibrationPreviewPosterUrl(shot, video)}" src="${calibrationPreviewVideoUrl(shot, video)}"></video>
                <div>
                  <strong>Camera ${index + 1}</strong>
                  <span>${video}</span>
                </div>
              </article>
            `)
            .join("")}
        </div>
      </section>
    `
    : "";

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
    ${cameraMarkup}
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

function annotatedPoseVideos(shot) {
  return (shot.pose_preview_videos || []).filter((video) => video !== "side_by_side.mp4");
}

function renderAnnotatedPoseClips(shot) {
  const videos = annotatedPoseVideos(shot);
  if (!videos.length) return "";

  return `
    <section class="pose-clip-grid" aria-label="Annotated camera clips">
      ${videos
        .map((video, index) => `
          <article class="clip-card">
            <video controls playsinline preload="metadata" ${posePreviewPosterExists(shot, video) ? `poster="${posePreviewPosterUrl(shot, video)}"` : ""} src="${posePreviewVideoUrl(shot, video)}"></video>
            <div>
              <strong>Camera ${index + 1}</strong>
              <span>${video}</span>
            </div>
          </article>
        `)
        .join("")}
    </section>
  `;
}

function renderInlinePoseClips(shot) {
  if (!motionInlineClips) return;
  const clips = renderAnnotatedPoseClips(shot);
  if (!clips) {
    motionInlineClips.innerHTML = "";
    return;
  }

  motionInlineClips.innerHTML = `
    <section class="inline-preview-section">
      <div class="inline-preview-heading">
        <strong>Annotated clips</strong>
        <span>Available before the combined preview is built.</span>
      </div>
      ${clips}
    </section>
  `;
}

function isManualAlignmentShot(shot) {
  const job = shot.latest_job;
  return shot.sync_method === "manual" || (job?.type === "sync" && job.method === "manual");
}

function completedManualResyncJob(shot) {
  const job = shot.latest_job;
  return job?.type === "manual_resync" && job.state === "complete" ? job : null;
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
  const progress = job?.type === "motion_capture" && isActiveJob(job) ? Number(job.progress) || 0 : 0;
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

function renderMotionOutputProgress(shot) {
  if (!motionOutputProgress) return;
  const artifact = shot.motion_capture_artifact || {};
  const annotatedCount = annotatedPoseVideos(shot).length;
  const items = [
    ["2D tracking", Boolean(artifact.data2d), artifact.data2d?.name],
    ["3D triangulation", Boolean(artifact.raw3d), artifact.raw3d?.name],
    ["Skeleton output", Boolean(artifact.data3d), artifact.data3d?.name],
    ["Annotated clips", annotatedCount > 0, annotatedCount ? `${annotatedCount} clip${annotatedCount === 1 ? "" : "s"}` : null],
  ];
  const hasAnyOutput = items.some(([, done]) => done);
  const runningMotion = shot.latest_job?.type === "motion_capture" && ["queued", "running"].includes(shot.latest_job.state);
  const failedMotion = shot.latest_job?.type === "motion_capture" && shot.latest_job.state === "failed";
  const hasPose = Boolean(shot.status?.data3d_status_check || shot.motion_capture_artifact?.data3d);

  if (!runningMotion && !hasAnyOutput) {
    motionOutputProgress.innerHTML = "";
    return;
  }

  motionOutputProgress.innerHTML = `
    <div class="pose-output-list" aria-live="polite">
      ${items
        .map(([label, done, detail]) => `
          <div class="${done ? hasPose ? "is-done" : "is-partial" : ""}">
            <span>${label}</span>
            <strong>${done ? hasPose ? "Done" : "Available" : failedMotion ? "Not created" : "Waiting"}</strong>
            <small>${detail || ""}</small>
          </div>
        `)
        .join("")}
    </div>
  `;
}

function renderPosePreview(shot) {
  const hasPose = Boolean(shot.status?.data3d_status_check || shot.motion_capture_artifact?.data3d);
  const hasAnnotatedVideos = annotatedPoseVideos(shot).length > 0;
  const runningMotion = shot.latest_job?.type === "motion_capture" && ["queued", "running"].includes(shot.latest_job.state);
  posePreviewButton.disabled = !hasAnnotatedVideos || runningMotion;

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
    ? runningMotion
      ? "Annotated camera clips are appearing as FreeMoCap writes them."
      : "Annotated camera clips are available. Build the combined side-by-side player when ready."
    : "Waiting for FreeMoCap annotated videos.";
  posePreviewPlayer.innerHTML = renderAnnotatedPoseClips(shot);
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
  renderMotionOutputProgress(shot);
  renderInlinePoseClips(shot);

  if (runningMotion) {
    setStatePill(motionState, `${job.progress}%`, "is-running");
    motionStatus.textContent = job.message;
  } else if (job?.type === "motion_capture" && job.state === "failed" && !hasData3d) {
    setStatePill(motionState, "Failed", "is-failed");
    motionStatus.textContent = `${job.message} You can run pose estimation again.`;
  } else if (hasData3d) {
    setStatePill(motionState, "Pose ready", "is-done");
    motionStatus.textContent = "FreeMoCap pose outputs are saved in output_data.";
  } else if (syncedVideoCount(shot) < 1) {
    setStatePill(motionState, "Needs sync", "is-muted");
    motionStatus.textContent = "Sync videos before pose estimation.";
  } else if (!hasCalibration) {
    setStatePill(motionState, "Needs calibration", "is-muted");
    motionStatus.textContent = "Run calibration before multi-camera pose estimation.";
  } else {
    setStatePill(motionState, "Ready", "is-ready");
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
  const frameImages = Array.from(panel.querySelectorAll("[data-resync-frame-preview]"));
  const baseFrameInput = panel.querySelector("[data-resync-base-frame]");
  const frameScrubber = panel.querySelector("[data-resync-frame-scrubber]");
  const status = panel.querySelector("[data-resync-status]");
  const applyButton = panel.querySelector("[data-apply-resync]");
  const fps = 30;
  let previewTimer = null;
  let previewRequestId = 0;
  const framePreviewControllers = new Map();

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
    let frameCounts = videos
      .map((video) => synchronizedVideoFrameCount(shot, video.dataset.videoName))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => value - 1);
    if (!frameCounts.length) {
      frameCounts = videos
        .filter((video) => Number.isFinite(video.duration) && video.duration > 0)
        .map((video) => {
          const videoFps = synchronizedVideoFps(shot, video.dataset.videoName) || fps;
          return Math.max(0, Math.floor(video.duration * videoFps) - 1);
        });
    }
    if (!frameCounts.length && isManualAlignmentShot(shot)) {
      frameCounts = Object.values(shot.status?.video_and_camera_info?.number_of_frames_in_videos || {})
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => value - 1);
    }
    const maxFrame = frameCounts.length ? Math.max(...frameCounts) : isManualAlignmentShot(shot) ? 100000 : 0;
    frameScrubber.max = String(maxFrame);
    baseFrameInput.max = String(maxFrame);
    if ((Number(baseFrameInput.value) || 0) > maxFrame) {
      baseFrameInput.value = String(maxFrame);
      frameScrubber.value = String(maxFrame);
    }
    return maxFrame;
  };

  const setBaseFrame = (frame) => {
    const currentMaxFrame = Number(frameScrubber.max);
    const maxFrame = Number.isFinite(currentMaxFrame) && currentMaxFrame > 0 ? currentMaxFrame : updateFrameLimit();
    const safeFrame = Math.max(0, Math.min(maxFrame, Math.round(Number(frame) || 0)));
    baseFrameInput.value = String(safeFrame);
    frameScrubber.value = String(safeFrame);
    persistResyncUiState();
  };

  const loadFramePreview = async (image, videoName, baseFrame, offset, requestId) => {
    const existing = framePreviewControllers.get(videoName);
    if (existing) existing.abort();

    const controller = new AbortController();
    framePreviewControllers.set(videoName, controller);
    const url = framePreviewUrl(shot, videoName, baseFrame, offset, requestId);

    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (requestId !== previewRequestId || controller.signal.aborted || response.status === 204) return;
      if (!response.ok) throw new Error(`Frame preview failed: ${response.status}`);

      const blob = await response.blob();
      if (requestId !== previewRequestId || controller.signal.aborted) return;

      const objectUrl = URL.createObjectURL(blob);
      if (image.dataset.objectUrl) {
        URL.revokeObjectURL(image.dataset.objectUrl);
      }
      image.dataset.objectUrl = objectUrl;
      image.src = objectUrl;
      image.hidden = false;
    } catch (error) {
      if (error.name !== "AbortError") {
        throw error;
      }
    } finally {
      if (framePreviewControllers.get(videoName) === controller) {
        framePreviewControllers.delete(videoName);
      }
    }
  };

  const previewOffsets = async () => {
    const requestId = ++previewRequestId;
    framePreviewControllers.forEach((controller) => controller.abort());
    framePreviewControllers.clear();
    await Promise.allSettled(videos.map(waitForVideoMetadata));
    if (requestId !== previewRequestId) return;
    updateFrameLimit();
    setBaseFrame(baseFrameInput.value);
    const baseFrame = Number(baseFrameInput.value) || 0;
    videos.forEach((video) => {
      const input = offsetInputs().find((candidate) => candidate.dataset.videoName === video.dataset.videoName);
      const offset = Number(input?.value) || 0;
      const targetFrame = Math.max(0, baseFrame + offset);
      const videoFrameCount = synchronizedVideoFrameCount(shot, video.dataset.videoName);
      const videoFps = synchronizedVideoFps(shot, video.dataset.videoName) || fps;
      const durationFrame = videoFrameCount
        ? Math.max(0, videoFrameCount - 1)
        : Number.isFinite(video.duration) ? Math.max(0, Math.floor(video.duration * videoFps) - 1) : targetFrame;
      const clampedTargetFrame = Math.min(targetFrame, durationFrame);
      video.currentTime = clampedTargetFrame / videoFps;
      const frameImage = frameImages.find((candidate) => candidate.dataset.videoName === video.dataset.videoName);
      if (frameImage && (isManualAlignmentShot(shot) || video.error || !Number.isFinite(video.duration))) {
        frameImage.hidden = false;
        video.hidden = true;
        loadFramePreview(frameImage, video.dataset.videoName, clampedTargetFrame, 0, requestId).catch((error) => {
          if (requestId === previewRequestId) setStatus(error.message, true);
        });
      }
    });
  };

  const schedulePreviewOffsets = (delay = 120) => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewOffsets().catch((error) => setStatus(error.message, true));
    }, delay);
  };

  panel.addEventListener("click", (event) => {
    const offsetButton = event.target.closest("[data-offset-step]");
    if (offsetButton) {
      const camera = offsetButton.closest("[data-resync-camera]");
      const input = camera?.querySelector("[data-resync-offset]");
      if (input) {
        input.value = String((Number(input.value) || 0) + Number(offsetButton.dataset.offsetStep));
        persistResyncUiState();
        schedulePreviewOffsets(80);
      }
      return;
    }

    const frameButton = event.target.closest("[data-resync-frame-step]");
    if (frameButton) {
      setBaseFrame((Number(baseFrameInput.value) || 0) + Number(frameButton.dataset.resyncFrameStep));
      schedulePreviewOffsets(80);
      return;
    }

    const calibrationButton = event.target.closest("[data-open-calibration]");
    if (calibrationButton) {
      detailTabTouched = true;
      showDetailTab("calibration");
    }
  });

  baseFrameInput.addEventListener("input", () => {
    setBaseFrame(baseFrameInput.value);
    schedulePreviewOffsets();
  });
  frameScrubber.addEventListener("input", () => {
    setBaseFrame(frameScrubber.value);
    schedulePreviewOffsets();
  });
  offsetInputs().forEach((input) => {
    input.addEventListener("change", () => {
      persistResyncUiState();
      schedulePreviewOffsets(80);
    });
  });
  frameImages.forEach((image) => {
    image.addEventListener("error", () => {
      setStatus("Frame preview failed. Make sure FFmpeg is available to the running server.", true);
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

  schedulePreviewOffsets(0);
}

async function ensureBrowserPreviews(shot) {
  if (isManualAlignmentShot(shot)) return;
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
  deleteShotButton.disabled = false;
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

async function deleteSelectedShot() {
  const shot = recordingsCache.find((recording) => recording.id === selectedShotId);
  if (!shot) return;
  const confirmed = window.confirm(`Force delete "${shot.name}"?\n\nThis removes the shot from the project and deletes its recording folder from disk.`);
  if (!confirmed) return;

  deleteShotButton.disabled = true;
  try {
    await api(`/api/shots/${encodeURIComponent(shot.id)}?force=true`, { method: "DELETE" });
    if (activeJobId === shot.latest_job?.id) {
      activeJobId = null;
      clearInterval(pollTimer);
      pollTimer = null;
    }
    selectedShotId = null;
    detailTabTouched = false;
    localStorage.removeItem(shotUiStateKey(shot.id));
    await refresh();
  } catch (error) {
    deleteShotButton.disabled = false;
    shotActivity.innerHTML = `<span class="error">${error.message}</span>`;
  }
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
  const selectedShot = recordingsCache.find((recording) => recording.id === job.shot_id);
  if (selectedShot) {
    renderShotActivity({ ...selectedShot, latest_job: job });
  } else {
    shotActivity.textContent = `${isActiveJob(job) ? "Running" : "Latest activity"}: ${jobTitle(job)} ${isActiveJob(job) ? `${job.progress}%` : ""}. ${job.message}`;
    shotActivity.className = `shot-activity ${isActiveJob(job) ? "is-running" : ""} ${job.state === "failed" ? "is-failed" : ""}`;
  }

  if (job.state === "complete") {
    clearInterval(pollTimer);
    pollTimer = null;
    if (job.type === "sync") {
      syncStatus.textContent = "Synchronized.";
      recordingName.value = defaultRecordingName();
      clearSelectedVideos();
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
fileInput.addEventListener("change", () => {
  addSelectedVideos(fileInput.files);
  fileInput.value = "";
  renderVideos();
});
syncMethod.addEventListener("change", renderVideos);
localVideoPaths.addEventListener("input", renderVideos);
refreshButton.addEventListener("click", refresh);
detailRefreshButton.addEventListener("click", refresh);
deleteShotButton.addEventListener("click", deleteSelectedShot);
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
  const localPaths = selectedLocalVideoPaths();
  const selectedSourceCount = videos.length + localPaths.length;
  if (selectedSourceCount < 1) {
    syncStatus.innerHTML = `<span class="error">Select one or more MP4 files or paste local video paths.</span>`;
    return;
  }

  const data = new FormData();
  data.append("recording_name", recordingName.value);
  data.append("purpose", document.querySelector('input[name="purpose"]:checked').value);
  data.append("synchronization_method", syncMethod.value);
  data.append("brightness_threshold", document.querySelector("#brightnessThreshold").value);
  data.append("local_video_paths", localPaths.join("\n"));
  videos.forEach((file) => data.append("files", file, file.name));

  clearInterval(pollTimer);
  pollTimer = null;
  jobConsole.classList.remove("is-hidden");
  syncStatus.textContent = "";
  setCreateProgress(10, "Loading", `Loading ${selectedSourceCount} selected videos.`);
  setCreateLog(`${selectedSourceCount} source videos selected`, localPaths.length ? "Copying local files into FreeMoCap Web" : "Uploading to FreeMoCap Web");
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
  data.append("calibration_start_time", calibrationStartTime.value || "0");
  data.append("calibration_end_time", calibrationEndTime.value || "0");

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
