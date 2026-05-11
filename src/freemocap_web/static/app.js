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

let pollTimer = null;
let activeJobId = null;
let selectedShotId = null;
let recordingsCache = [];
let activeView = null;

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
  const ffmpeg = system.ffmpeg_available ? "FFmpeg found" : "FFmpeg missing";
  systemStatus.textContent = `${system.recording_session_folder_path}\n${ffmpeg}, ${sync}`;
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
  if (job?.state === "failed") return { className: "failed", text: "Failed" };
  if (["queued", "running"].includes(job?.state)) return { className: "pending", text: `${job.progress}%` };
  if (hasVideos || job?.state === "complete") return { className: "", text: "Synced" };
  return { className: "pending", text: "Draft" };
}

function jobTitle(job) {
  if (!job) return "No job";
  if (job.state === "complete") return "Complete";
  if (job.state === "failed") return "Failed";
  if (job.state === "queued") return "Queued";
  return "Syncing";
}

function mediaCacheKey(shot) {
  return shot.browser_preview_updated_at || shot.side_by_side_updated_at || Date.now();
}

function videoUrl(shot, filename) {
  return `/api/shots/${encodeURIComponent(shot.id)}/videos/${encodeURIComponent(filename)}?v=${encodeURIComponent(mediaCacheKey(shot))}`;
}

function posterUrl(shot, filename) {
  const posterName = filename.replace(/\.mp4$/i, ".jpg");
  return `/api/shots/${encodeURIComponent(shot.id)}/posters/${encodeURIComponent(posterName)}?v=${encodeURIComponent(mediaCacheKey(shot))}`;
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = Math.floor(safeSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

function renderLinkedPlayer(shot) {
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
  if (shot.browser_videos?.length || !shot.videos.length) return;
  selectedShotVideos.innerHTML = `<div class="video-row muted">Preparing browser playback clips...</div>`;
  try {
    await api(`/api/shots/${encodeURIComponent(shot.id)}/browser-previews`, { method: "POST" });
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
  selectedShotVideos.innerHTML = renderLinkedPlayer(shot);
  setupLinkedPlayer();
  ensureBrowserPreviews(shot);

  if (!job) {
    activeJobId = null;
    setDetailProgress(0, "No job", "This shot does not have a sync job yet.");
    setDetailLog(shot.name, "No job has been started.");
    return;
  }

  activeJobId = job.id;
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
  const { job } = await api(`/api/sync-jobs/${jobId}`);
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
    syncStatus.textContent = "Synchronized.";
    activeJobId = null;
    recordingName.value = defaultRecordingName();
    fileInput.value = "";
    renderVideos();
    await refresh();
    setBusy(false);
    return;
  }

  if (job.state === "failed") {
    clearInterval(pollTimer);
    pollTimer = null;
    syncStatus.innerHTML = `<span class="error">${job.message}</span>`;
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

renderVideos();
refresh().catch((error) => {
  systemStatus.textContent = error.message;
});
