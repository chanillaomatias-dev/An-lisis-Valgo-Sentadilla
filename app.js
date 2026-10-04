const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');

let cameraInstance = null;
let currentFacingMode = 'user';
let repCount = 0;
let isDescending = false;
let peakValgusLeft = 0;
let peakValgusRight = 0;

// Configuración inicial de Chart.js
const ctxChart = document.getElementById('kinematicsChart').getContext('2d');
const chart = new Chart(ctxChart, {
  type: 'line',
  data: {
    labels: Array(30).fill(''),
    datasets: [
      { label: 'FPPA Izq (°)', data: Array(30).fill(0), borderColor: '#06b6d4', borderWidth: 2, fill: false },
      { label: 'FPPA Der (°)', data: Array(30).fill(0), borderColor: '#f43f5e', borderWidth: 2, fill: false }
    ]
  },
  options: {
    responsive: true,
    scales: { y: { min: 0, max: 25, grid: { color: '#334155' } }, x: { display: false } },
    animation: false
  }
});

// Función matemática: Cálculo de FPPA
function calculateFPPA(hip, knee, ankle) {
  const v1 = { x: hip.x - knee.x, y: hip.y - knee.y };
  const v2 = { x: ankle.x - knee.x, y: ankle.y - knee.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);
  if (mag1 === 0 || mag2 === 0) return 0;
  const rad = Math.acos(Math.min(Math.max(dot / (mag1 * mag2), -1.0), 1.0));
  const fullAngle = rad * (180 / Math.PI);
  return Math.abs(180 - fullAngle).toFixed(1);
}

// MediaPipe Loop
function onResults(results) {
  canvasElement.width = videoElement.videoWidth;
  canvasElement.height = videoElement.videoHeight;
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  if (!results.poseLandmarks) {
    canvasCtx.restore();
    return;
  }

  const lm = results.poseLandmarks;
  const lHip = lm[23], rHip = lm[24];
  const lKnee = lm[25], rKnee = lm[26];
  const lAnkle = lm[27], rAnkle = lm[28];

  // Dibujar puntos
  [lHip, rHip, lKnee, rKnee, lAnkle, rAnkle].forEach(pt => {
    canvasCtx.beginPath();
    canvasCtx.arc(pt.x * canvasElement.width, pt.y * canvasElement.height, 6, 0, 2 * Math.PI);
    canvasCtx.fillStyle = '#06b6d4';
    canvasCtx.fill();
  });

  // Conectar líneas
  canvasCtx.strokeStyle = '#38bdf8';
  canvasCtx.lineWidth = 3;
  const drawLine = (p1, p2) => {
    canvasCtx.beginPath();
    canvasCtx.moveTo(p1.x * canvasElement.width, p1.y * canvasElement.height);
    canvasCtx.lineTo(p2.x * canvasElement.width, p2.y * canvasElement.height);
    canvasCtx.stroke();
  };
  drawLine(lHip, lKnee); drawLine(lKnee, lAnkle);
  drawLine(rHip, rKnee); drawLine(rKnee, rAnkle);

  // Calcular FPPA
  const fppaL = calculateFPPA(lHip, lKnee, lAnkle);
  const fppaR = calculateFPPA(rHip, rKnee, rAnkle);

  document.getElementById('fppa-left').innerText = `${fppaL}°`;
  document.getElementById('fppa-right').innerText = `${fppaR}°`;

  updateBadge('badge-left', fppaL);
  updateBadge('badge-right', fppaR);

  // Ratio
  const kneeDist = Math.hypot(lKnee.x - rKnee.x, lKnee.y - rKnee.y);
  const ankleDist = Math.hypot(lAnkle.x - rAnkle.x, lAnkle.y - rAnkle.y);
  const ratio = Math.round((kneeDist / (ankleDist || 1)) * 100);
  document.getElementById('ratio-val').innerText = `${ratio}%`;

  // Actualizar gráfico en vivo
  chart.data.datasets[0].data.shift();
  chart.data.datasets[0].data.push(parseFloat(fppaL));
  chart.data.datasets[1].data.shift();
  chart.data.datasets[1].data.push(parseFloat(fppaR));
  chart.update();

  // Detección automática de repetición por altura de cadera
  const avgHipY = (lHip.y + rHip.y) / 2;
  const avgKneeY = (lKnee.y + rKnee.y) / 2;

  if (avgHipY > avgKneeY * 0.75) {
    isDescending = true;
    peakValgusLeft = Math.max(peakValgusLeft, parseFloat(fppaL));
    peakValgusRight = Math.max(peakValgusRight, parseFloat(fppaR));
  } else if (isDescending && avgHipY < avgKneeY * 0.65) {
    isDescending = false;
    repCount++;
    addRepToTable(repCount, peakValgusLeft, peakValgusRight);
    peakValgusLeft = 0;
    peakValgusRight = 0;
  }

  canvasCtx.restore();
}

function updateBadge(id, angle) {
  const el = document.getElementById(id);
  const val = parseFloat(angle);
  if (val < 5) {
    el.className = 'badge safe';
    el.innerText = 'Alineación Normal';
  } else if (val <= 12) {
    el.className = 'badge moderate';
    el.innerText = 'Valgo Leve/Mod.';
  } else {
    el.className = 'badge risk';
    el.innerText = 'Alto Valgo (Riesgo)';
  }
}

function addRepToTable(rep, maxL, maxR) {
  const table = document.getElementById('reps-table').querySelector('tbody');
  const row = table.insertRow();
  const maxPeak = Math.max(maxL, maxR);
  const risk = maxPeak > 12 ? 'Alto' : maxPeak > 5 ? 'Moderado' : 'Bajo';
  row.innerHTML = `<td>#${rep}</td><td>${maxL.toFixed(1)}°</td><td>${maxR.toFixed(1)}°</td><td>${risk}</td>`;
}

// Configurar MediaPipe Pose
const pose = new Pose({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
});
pose.setOptions({ modelComplexity: 1, smoothLandmarks: true, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
pose.onResults(onResults);

// Botón de encendido de cámara
document.getElementById('btn-toggle-cam').addEventListener('click', async () => {
  if (!cameraInstance) {
    cameraInstance = new Camera(videoElement, {
      onFrame: async () => { await pose.send({ image: videoElement }); },
      width: 640,
      height: 480,
    });
    await cameraInstance.start();
    document.getElementById('camera-status').innerText = 'Cámara: Activa';
    document.getElementById('camera-status').style.background = '#15803d';
  }
});