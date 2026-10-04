const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const countdownEl = document.getElementById('countdown-overlay');
const btnSingleSquat = document.getElementById('btn-single-squat');
const btnReset = document.getElementById('btn-reset-eval');

let cameraInstance = null;
let repCount = 0;

let evalState = 'IDLE'; 
let peakValgusLeft = 0;
let peakValgusRight = 0;
let nadirKneeDistRatio = 100;
let baselineHipY = null;

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

function calculateFPPA(hip, knee, ankle) {
  const v1 = { x: hip.x - knee.x, y: hip.y - knee.y };
  const v2 = { x: ankle.x - knee.x, y: ankle.y - knee.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);
  if (mag1 === 0 || mag2 === 0) return 0;
  const rad = Math.acos(Math.min(Math.max(dot / (mag1 * mag2), -1.0), 1.0));
  return Math.abs(180 - (rad * (180 / Math.PI))).toFixed(1);
}

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

  if (evalState === 'FINISHED') {
    canvasCtx.restore();
    return;
  }

  if ((lKnee.visibility && lKnee.visibility < 0.4) || (rKnee.visibility && rKnee.visibility < 0.4)) {
    canvasCtx.restore();
    return;
  }

  [lHip, rHip, lKnee, rKnee, lAnkle, rAnkle].forEach(pt => {
    canvasCtx.beginPath();
    canvasCtx.arc(pt.x * canvasElement.width, pt.y * canvasElement.height, 6, 0, 2 * Math.PI);
    canvasCtx.fillStyle = '#06b6d4';
    canvasCtx.fill();
  });

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

  const fppaL = calculateFPPA(lHip, lKnee, lAnkle);
  const fppaR = calculateFPPA(rHip, rKnee, rAnkle);

  document.getElementById('fppa-left').innerText = `${fppaL}°`;
  document.getElementById('fppa-right').innerText = `${fppaR}°`;
  updateBadge('badge-left', fppaL);
  updateBadge('badge-right', fppaR);

  const kneeDist = Math.hypot(lKnee.x - rKnee.x, lKnee.y - rKnee.y);
  const ankleDist = Math.hypot(lAnkle.x - rAnkle.x, lAnkle.y - rAnkle.y);
  const currentRatio = Math.round((kneeDist / (ankleDist || 1)) * 100);
  document.getElementById('ratio-val').innerText = `${currentRatio}%`;

  chart.data.datasets[0].data.shift();
  chart.data.datasets[0].data.push(parseFloat(fppaL));
  chart.data.datasets[1].data.shift();
  chart.data.datasets[1].data.push(parseFloat(fppaR));
  chart.update();

  const currentHipY = (lHip.y + rHip.y) / 2;

  if (evalState === 'WAIT_DESCENT') {
    baselineHipY = currentHipY;
    if (currentHipY > baselineHipY + 0.04) {
      evalState = 'RECORDING';
      showNotice('¡Descendiendo! Controla las rodillas...');
    }
  } else if (evalState === 'RECORDING') {
    if (parseFloat(fppaL) > peakValgusLeft) peakValgusLeft = parseFloat(fppaL);
    if (parseFloat(fppaR) > peakValgusRight) peakValgusRight = parseFloat(fppaR);
    if (currentRatio < nadirKneeDistRatio) nadirKneeDistRatio = currentRatio;

    if (currentHipY < baselineHipY + 0.03) {
      evalState = 'FINISHED';
      repCount++;
      addRepToTable(repCount, peakValgusLeft, peakValgusRight);
      showNotice('¡Evaluación Completa! ✅');
      btnReset.style.display = 'inline-block';
      btnSingleSquat.style.display = 'none';

      document.getElementById('fppa-left').innerText = `${peakValgusLeft.toFixed(1)}° (Pico)`;
      document.getElementById('fppa-right').innerText = `${peakValgusRight.toFixed(1)}° (Pico)`;
      document.getElementById('ratio-val').innerText = `${nadirKneeDistRatio}% (Mínimo)`;
      updateBadge('badge-left', peakValgusLeft);
      updateBadge('badge-right', peakValgusRight);
    }
  }

  canvasCtx.restore();
}

function showNotice(text) {
  countdownEl.style.display = 'block';
  countdownEl.style.fontSize = '2rem';
  countdownEl.innerText = text;
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
  const risk = maxPeak > 12 ? 'Alto Riesgo' : maxPeak > 5 ? 'Moderado' : 'Bajo / Normal';
  row.innerHTML = `<td>#${rep}</td><td>${maxL.toFixed(1)}°</td><td>${maxR.toFixed(1)}°</td><td><strong>${risk}</strong></td>`;
}

btnSingleSquat.addEventListener('click', () => {
  if (!cameraInstance) {
    alert('Primero debes presionar "Iniciar Cámara".');
    return;
  }
  
  evalState = 'COUNTDOWN';
  let counter = 3;
  countdownEl.style.display = 'block';
  countdownEl.style.fontSize = '5rem';
  countdownEl.innerText = counter;

  const timer = setInterval(() => {
    counter--;
    if (counter > 0) {
      countdownEl.innerText = counter;
    } else if (counter === 0) {
      countdownEl.innerText = '¡BAJA!';
    } else {
      clearInterval(timer);
      countdownEl.style.fontSize = '1.8rem';
      countdownEl.innerText = 'Realiza la sentadilla...';
      evalState = 'WAIT_DESCENT';
      peakValgusLeft = 0;
      peakValgusRight = 0;
      nadirKneeDistRatio = 100;
    }
  }, 1000);
});

btnReset.addEventListener('click', () => {
  evalState = 'IDLE';
  countdownEl.style.display = 'none';
  btnReset.style.display = 'none';
  btnSingleSquat.style.display = 'inline-block';
  document.getElementById('fppa-left').innerText = '0.0°';
  document.getElementById('fppa-right').innerText = '0.0°';
  document.getElementById('ratio-val').innerText = '100%';
});

const pose = new Pose({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
});
pose.setOptions({
  modelComplexity: 2,
  smoothLandmarks: true,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
});
pose.onResults(onResults);

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
