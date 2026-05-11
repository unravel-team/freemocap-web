import * as THREE from "./vendor/three.module.js";

const BODY_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
];

function formatFrame(index, count) {
  return `${index + 1} / ${count}`;
}

function bodyPointToScene(point, center) {
  const scale = 0.001;
  return new THREE.Vector3(
    (point[0] - center[0]) * scale,
    (point[2] - center[2]) * scale,
    -(point[1] - center[1]) * scale,
  );
}

function createViewerShell(root) {
  root.innerHTML = `
    <article class="pose3d-viewer">
      <div class="pose3d-canvas" data-pose3d-canvas></div>
      <div class="pose3d-controls">
        <button class="secondary" type="button" data-pose3d-play>Play</button>
        <span data-pose3d-frame>0 / 0</span>
        <input type="range" min="0" max="0" value="0" step="1" data-pose3d-seek />
        <output data-pose3d-status>Loading 3D skeleton...</output>
      </div>
    </article>
  `;
}

export async function mountPose3dViewer(root, dataUrl) {
  if (!root || !dataUrl) return;
  if (root.__pose3dCleanup) {
    root.__pose3dCleanup();
    root.__pose3dCleanup = null;
  }

  createViewerShell(root);
  const canvasHost = root.querySelector("[data-pose3d-canvas]");
  const playButton = root.querySelector("[data-pose3d-play]");
  const seek = root.querySelector("[data-pose3d-seek]");
  const frameLabel = root.querySelector("[data-pose3d-frame]");
  const status = root.querySelector("[data-pose3d-status]");

  let payload;
  try {
    const response = await fetch(dataUrl);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || response.statusText);
    }
    payload = await response.json();
  } catch (error) {
    status.innerHTML = `<span class="error">${error.message || "Failed to load 3D skeleton."}</span>`;
    return;
  }

  const frames = payload.frames || [];
  if (!frames.length) {
    status.textContent = "No 3D frames found.";
    return;
  }

  const boundsMin = payload.bounds?.min || [0, 0, 0];
  const boundsMax = payload.bounds?.max || [0, 0, 0];
  const center = [
    (boundsMin[0] + boundsMax[0]) / 2,
    (boundsMin[1] + boundsMax[1]) / 2,
    (boundsMin[2] + boundsMax[2]) / 2,
  ];
  const floorY = (boundsMin[2] - center[2]) * 0.001;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf6fafb);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  canvasHost.appendChild(renderer.domElement);

  const ambientLight = new THREE.HemisphereLight(0xffffff, 0xc7d2da, 2.6);
  scene.add(ambientLight);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
  keyLight.position.set(4, 7, 6);
  scene.add(keyLight);

  const gridSize = Math.max(4, Math.ceil(Math.max(
    Math.abs(boundsMax[0] - boundsMin[0]),
    Math.abs(boundsMax[1] - boundsMin[1]),
  ) / 1000));
  const grid = new THREE.GridHelper(gridSize, gridSize, 0x6f8793, 0xd4e0e5);
  grid.position.y = floorY;
  scene.add(grid);

  const axes = new THREE.AxesHelper(0.6);
  axes.position.set(-gridSize / 2, floorY + 0.02, -gridSize / 2);
  scene.add(axes);

  const jointGeometry = new THREE.BufferGeometry();
  const jointPositions = new Float32Array(frames[0].length * 3);
  jointGeometry.setAttribute("position", new THREE.BufferAttribute(jointPositions, 3));
  const joints = new THREE.Points(
    jointGeometry,
    new THREE.PointsMaterial({ color: 0x0f1720, size: 0.045, sizeAttenuation: true }),
  );
  scene.add(joints);

  const lineGeometry = new THREE.BufferGeometry();
  const linePositions = new Float32Array(BODY_CONNECTIONS.length * 2 * 3);
  lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
  const bones = new THREE.LineSegments(
    lineGeometry,
    new THREE.LineBasicMaterial({ color: 0x0e7490, linewidth: 2 }),
  );
  scene.add(bones);

  let frameIndex = 0;
  let playing = false;
  let lastFrameTime = 0;
  let radius = Math.max(3.2, gridSize * 0.95);
  let theta = Math.PI * 0.22;
  let phi = Math.PI * 0.35;
  let dragging = false;
  let lastPointer = null;

  const updateCamera = () => {
    const x = radius * Math.sin(phi) * Math.sin(theta);
    const y = radius * Math.cos(phi);
    const z = radius * Math.sin(phi) * Math.cos(theta);
    camera.position.set(x, y + 0.9, z);
    camera.lookAt(0, 0.8, 0);
  };

  const updateFrame = (index) => {
    frameIndex = Math.max(0, Math.min(frames.length - 1, index));
    const points = frames[frameIndex];

    points.forEach((point, pointIndex) => {
      const scenePoint = bodyPointToScene(point, center);
      jointPositions[pointIndex * 3] = scenePoint.x;
      jointPositions[pointIndex * 3 + 1] = scenePoint.y;
      jointPositions[pointIndex * 3 + 2] = scenePoint.z;
    });
    jointGeometry.attributes.position.needsUpdate = true;

    BODY_CONNECTIONS.forEach(([start, end], connectionIndex) => {
      const startPoint = bodyPointToScene(points[start] || [0, 0, 0], center);
      const endPoint = bodyPointToScene(points[end] || [0, 0, 0], center);
      const offset = connectionIndex * 6;
      linePositions[offset] = startPoint.x;
      linePositions[offset + 1] = startPoint.y;
      linePositions[offset + 2] = startPoint.z;
      linePositions[offset + 3] = endPoint.x;
      linePositions[offset + 4] = endPoint.y;
      linePositions[offset + 5] = endPoint.z;
    });
    lineGeometry.attributes.position.needsUpdate = true;

    seek.value = String(frameIndex);
    frameLabel.textContent = formatFrame(frameIndex, frames.length);
  };

  const resize = () => {
    const rect = canvasHost.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(300, Math.floor(rect.height));
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, true);
  };

  const render = (timestamp = 0) => {
    if (playing) {
      const frameDuration = 1000 / Math.max(1, (payload.fps || 30) / (payload.stride || 1));
      if (!lastFrameTime || timestamp - lastFrameTime >= frameDuration) {
        updateFrame((frameIndex + 1) % frames.length);
        lastFrameTime = timestamp;
      }
    }
    renderer.render(scene, camera);
    root.__pose3dAnimationFrame = requestAnimationFrame(render);
  };

  seek.max = String(frames.length - 1);
  seek.addEventListener("input", () => {
    playing = false;
    playButton.textContent = "Play";
    updateFrame(Number(seek.value));
  });
  playButton.addEventListener("click", () => {
    playing = !playing;
    playButton.textContent = playing ? "Pause" : "Play";
    lastFrameTime = 0;
  });
  renderer.domElement.addEventListener("pointerdown", (event) => {
    dragging = true;
    lastPointer = { x: event.clientX, y: event.clientY };
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener("pointermove", (event) => {
    if (!dragging || !lastPointer) return;
    const deltaX = event.clientX - lastPointer.x;
    const deltaY = event.clientY - lastPointer.y;
    theta -= deltaX * 0.008;
    phi = Math.max(0.12, Math.min(Math.PI * 0.82, phi + deltaY * 0.006));
    lastPointer = { x: event.clientX, y: event.clientY };
    updateCamera();
  });
  renderer.domElement.addEventListener("pointerup", () => {
    dragging = false;
    lastPointer = null;
  });
  renderer.domElement.addEventListener("wheel", (event) => {
    event.preventDefault();
    radius = Math.max(1.2, Math.min(18, radius + event.deltaY * 0.004));
    updateCamera();
  }, { passive: false });

  window.addEventListener("resize", resize);
  updateCamera();
  updateFrame(0);
  resize();
  status.textContent = `${payload.source} · ${payload.frame_count} frames · ${payload.marker_count} body landmarks`;
  render();

  root.__pose3dCleanup = () => {
    cancelAnimationFrame(root.__pose3dAnimationFrame);
    window.removeEventListener("resize", resize);
    renderer.dispose();
    jointGeometry.dispose();
    lineGeometry.dispose();
  };
}
