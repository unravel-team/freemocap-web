import * as THREE from "./vendor/three.module.js";

function cameraPositionToScene(position) {
  const scale = 0.001;
  return new THREE.Vector3(
    (Number(position?.[0]) || 0) * scale,
    (Number(position?.[2]) || 0) * scale,
    -(Number(position?.[1]) || 0) * scale,
  );
}

function drawRoundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function createShell(root) {
  root.innerHTML = `
    <article class="calibration3d-viewer">
      <div class="calibration3d-canvas" data-calibration3d-canvas></div>
      <div class="calibration3d-caption" data-calibration3d-caption></div>
    </article>
  `;
}

function makeTextSprite(text) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  canvas.width = 256;
  canvas.height = 96;
  context.fillStyle = "rgba(246, 250, 251, 0.92)";
  context.strokeStyle = "rgba(92, 112, 124, 0.35)";
  context.lineWidth = 3;
  drawRoundedRect(context, 8, 18, 240, 58, 16);
  context.fill();
  context.stroke();
  context.fillStyle = "#111a20";
  context.font = "700 28px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 128, 48);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.7, 0.26, 1);
  return sprite;
}

function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        if (material.map) material.map.dispose();
        material.dispose();
      });
    }
  });
}

function getBounds(points) {
  const box = new THREE.Box3().setFromPoints([...points, new THREE.Vector3(0, 0, 0)]);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  return { box, center, size };
}

export function mountCalibration3dViewer(root, artifact) {
  if (!root || !artifact) return;
  if (root.__calibration3dCleanup) {
    root.__calibration3dCleanup();
    root.__calibration3dCleanup = null;
  }

  createShell(root);
  const canvasHost = root.querySelector("[data-calibration3d-canvas]");
  const caption = root.querySelector("[data-calibration3d-caption]");
  const cameras = artifact.cameras || [];
  if (!cameras.length) {
    caption.textContent = "No camera positions found in calibration TOML.";
    return;
  }

  const positions = cameras.map((camera) => camera.world_position || camera.camera_center || [0, 0, 0]);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf6fafb);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  canvasHost.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xcbd8de, 2.5));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.3);
  keyLight.position.set(3, 6, 4);
  scene.add(keyLight);

  const scenePositions = positions.map((position) => cameraPositionToScene(position));
  const bounds = getBounds(scenePositions);
  const rigSpan = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 1);
  const radiusFromCameras = Math.max(2.5, rigSpan * 1.35);

  const gridSize = Math.max(3, Math.ceil(Math.max(rigSpan * 1.6, Math.abs(bounds.center.x) * 2.2, Math.abs(bounds.center.z) * 2.2)));
  const grid = new THREE.GridHelper(gridSize, 12, 0x2c8f87, 0xa9cfce);
  grid.position.y = 0;
  scene.add(grid);
  const axes = new THREE.AxesHelper(0.9);
  scene.add(axes);

  const originMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 24, 24),
    new THREE.MeshStandardMaterial({ color: 0x111a20 }),
  );
  originMarker.position.set(0, 0.045, 0);
  scene.add(originMarker);

  const frustumMaterial = new THREE.LineBasicMaterial({ color: 0x0f8f8a });
  scenePositions.forEach((position, index) => {
    const body = new THREE.Group();
    const cameraBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.16, 0.14),
      new THREE.MeshStandardMaterial({ color: 0x078f89, roughness: 0.55 }),
    );
    body.add(cameraBox);
    const lens = new THREE.Mesh(
      new THREE.ConeGeometry(0.065, 0.12, 24),
      new THREE.MeshStandardMaterial({ color: 0x10242a, roughness: 0.5 }),
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.z = -0.12;
    body.add(lens);
    body.position.copy(position);
    body.position.y = Math.max(0.12, body.position.y);
    body.lookAt(0, 0, 0);
    scene.add(body);

    const frustumGeometry = new THREE.BufferGeometry().setFromPoints([
      body.position,
      new THREE.Vector3(0, 0.03, 0),
    ]);
    scene.add(new THREE.Line(frustumGeometry, frustumMaterial));

    const label = makeTextSprite(`Camera ${index + 1}`);
    label.position.copy(body.position);
    label.position.y += 0.28;
    scene.add(label);
  });

  let radius = radiusFromCameras * 1.35;
  let theta = Math.PI * 0.24;
  let phi = Math.PI * 0.34;
  let dragging = false;
  let lastPointer = null;

  const updateCamera = () => {
    const x = radius * Math.sin(phi) * Math.sin(theta);
    const y = radius * Math.cos(phi);
    const z = radius * Math.sin(phi) * Math.cos(theta);
    camera.position.set(bounds.center.x + x, Math.max(0.9, bounds.center.y + y), bounds.center.z + z);
    camera.lookAt(bounds.center.x, Math.max(0.2, bounds.center.y * 0.45), bounds.center.z);
  };

  const resize = () => {
    const rect = canvasHost.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(280, Math.floor(rect.height));
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, true);
  };

  const resizeObserver = new ResizeObserver(resize);

  const render = () => {
    renderer.render(scene, camera);
    root.__calibration3dAnimationFrame = requestAnimationFrame(render);
  };

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
    phi = Math.max(0.16, Math.min(Math.PI * 0.82, phi + deltaY * 0.006));
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

  const positionSource = artifact.position_source === "world_position" ? "TOML world_position" : "extrinsic camera center";
  caption.textContent = `${artifact.camera_count} calibrated cameras · ${artifact.groundplane_calibration ? "ChArUco ground plane" : "Camera 0 origin"} · ${positionSource}`;
  window.addEventListener("resize", resize);
  resizeObserver.observe(canvasHost);
  updateCamera();
  resize();
  requestAnimationFrame(resize);
  render();

  root.__calibration3dCleanup = () => {
    cancelAnimationFrame(root.__calibration3dAnimationFrame);
    window.removeEventListener("resize", resize);
    resizeObserver.disconnect();
    disposeObject(scene);
    renderer.dispose();
  };
}
