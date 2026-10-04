const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const countdownEl = document.getElementById('countdown-overlay');
const btnSingleSquat = document.getElementById('btn-single-squat');
const btnReset = document.getElementById('btn-reset-eval');
const statusBadge = document.getElementById('camera-status');

let cameraInstance = null;
let repCount = 0;

// Máquina de estados: 'IDLE' | 'COUNTDOWN' | 'WAIT_DESCENT' | 'RECORDING' | 'FINISHED'
let evalState = 'IDLE'; 
let peakValgusLeft = 0;
let peakValgusRight = 0;
let nadirKneeDistRatio = 100;
let baselineHipY = null;

// Filtro Paso Bajo Exponencial (EMA) para suavizado cinemático
let smoothL = 0;
let smoothR = 0;
const EMA_ALPHA = 0.35;

// Monitoreo de frecuencia de muestreo (FPS)
let lastFrameTime = performance.now();
let frameCount = 0;
let fps = 0;

// Configuración de Chart.js
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

// Síntesis de voz para feedback auditivo
function speakFeedback(text) {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-CL';
    utterance.rate = 1.0;
    window.speechSynthesis.speak(utterance);
  }
}

// Función bioinstrumental: FPPA con producto cruz 2D (Valgo vs. Varo estricto)
function calculateSignedFPPA(hip, knee, ankle, isLeftLeg) {
  const vLine = { x: ankle.x - hip.x, y: ankle.y - hip.y };
  const vKnee = { x: knee.x - hip.x, y: knee.y - hip.y };

  const lineMag = Math.hypot(vLine.x, vLine.y);
  if (lineMag === 0) return { angle: 0, type: 'Neutro' };

  // Producto cruz 2D para evaluar desplazamiento transversal respecto al vector cadera-tobillo
  const cross = (vLine.x * vKnee.y) - (vLine.y * vKnee.x);

  const v1 = { x: hip.x - knee.x, y: hip.y - knee.y };
  const v2 = { x: ankle.x - knee.x, y: ankle.y - knee.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);
  if (mag1 === 0 || mag2 === 0) return { angle: 0, type: 'Neutro' };

  const rad = Math.acos(Math.min(Math.max(dot / (mag1 * mag2), -1.0), 1.0));
  const rawAngle = Math.abs(180 - (rad * (180 / Math.PI)));

  // Determinar dirección de colapso medial (Valgo)
  const isValgus = isLeftLeg ? (cross < 0) : (cross > 0);

  if (rawAngle < 3.0) {
    return { angle: rawAngle, type: 'Neutro' };
  } else if (isValgus) {
    return { angle: rawAngle, type: 'Valgo' };
  } else {
    return { angle: rawAngle, type: 'Varo' };
  }
}

// Bucle de adquisición y procesamiento MediaPipe
function onResults(results) {
  // Cálculo de FPS
  frameCount++;
  const now = performance.now();
  if (now - lastFrameTime >= 1000) {
    fps = frameCount;
    frameCount = 0;
    lastFrameTime = now;
    statusBadge.innerText = `Cámara: Activa (${fps} FPS)`;
  }

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

  // Si la evaluación terminó, mantener congelado el resultado
  if (evalState === 'FINISHED') {
    canvasCtx.restore();
    return;
  }

  // Filtrado por índice de visibilidad articular
  if ((lKnee.visibility && lKnee.visibility < 0.45) || (rKnee.visibility && rKnee.visibility < 0.45)) {
    canvasCtx.restore();
    return;
  }

  // Dibujar esqueletograma sobre canvas
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

  // Cálculo cinemático
  const rawL = calculateSignedFPPA(lHip, lKnee, lAnkle, true);
  const rawR = calculateSignedFPPA(rHip, rKnee, rAnkle, false);

  // Aplicación del filtro EMA para suavizar la señal
  smoothL = (EMA_ALPHA * rawL.angle) + ((1 - EMA_ALPHA) * smoothL);
  smoothR = (EMA_ALPHA * rawR.angle) + ((1 - EMA_ALPHA) * smoothR);

  const displayAngleL = parseFloat(smoothL.toFixed(1));
  const displayAngleR = parseFloat(smoothR.toFixed(1));

  document.getElementById('fppa-left').innerText = `${displayAngleL}° (${rawL.type})`;
  document.getElementById('fppa-right').innerText = `${displayAngleR}° (${rawR.type})`;
  updateBadge('badge-left', { angle: displayAngleL, type: rawL.type });
  updateBadge('badge-right', { angle: displayAngleR, type: rawR.type });

  // Ratio Inter-rodilla / Inter-tobillo
  const kneeDist = Math.hypot(lKnee.x - rKnee.x, lKnee.y - rKnee.y);
  const ankleDist = Math.hypot(lAnkle.x - rAnkle.x, lAnkle.y - rAnkle.y);
  const currentRatio = Math.round((kneeDist / (ankleDist || 1)) * 100);
  document.getElementById('ratio-val').innerText = `${currentRatio}%`;

  // Actualizar gráfica dinámica (solo valores de valgo para la curva de sobrecarga)
  chart.data.datasets[0].data.shift();
  chart.data.datasets[0].data.push(rawL.type === 'Valgo' ? displayAngleL : 0);
  chart.data.datasets[1].data.shift();
  chart.data.datasets[1].data.push(rawR.type === 'Valgo' ? displayAngleR : 0);
  chart.update();

  // Segmentación temporal de la sentadilla
  const currentHipY = (lHip.y + rHip.y) / 2;

  if (evalState === 'WAIT_DESCENT') {
    baselineHipY = currentHipY;
    if (currentHipY > baselineHipY + 0.04) {
      evalState = 'RECORDING';
      showNotice('¡Descendiendo! Controla las rodillas...');
    }
  } else if (evalState === 'RECORDING') {
    // Registro de picos exclusivamente durante valgo dinámico
    if (rawL.type === 'Valgo' && displayAngleL > peakValgusLeft) peakValgusLeft = displayAngleL;
    if (rawR.type === 'Valgo' && displayAngleR > peakValgusRight) peakValgusRight = displayAngleR;
    if (currentRatio < nadirKneeDistRatio) nadirKneeDistRatio = currentRatio;

    // Criterio de retorno a bipedestación (fin de fase concéntrica)
    if (currentHipY < baselineHipY + 0.03) {
      evalState = 'FINISHED';
      repCount++;
      addRepToTable(repCount, peakValgusLeft, peakValgusRight);
      showNotice('¡Evaluación Completa! ✅');
      btnReset.style.display = 'inline-block';
      btnSingleSquat.style.display = 'none';

      document.getElementById('fppa-left').innerText = `${peakValgusLeft.toFixed(1)}° (Pico Valgo)`;
      document.getElementById('fppa-right').innerText = `${peakValgusRight.toFixed(1)}° (Pico Valgo)`;
      document.getElementById('ratio-val').innerText = `${nadirKneeDistRatio}% (Mínimo)`;
      updateBadge('badge-left', { angle: peakValgusLeft, type: 'Valgo' });
      updateBadge('badge-right', { angle: peakValgusRight, type: 'Valgo' });

      // Generar reporte clínico y emitir síntesis de voz
      generateClinicalReport(peakValgusLeft, peakValgusRight);
    }
  }

  canvasCtx.restore();
}

function showNotice(text) {
  countdownEl.style.display = 'block';
  countdownEl.innerText = text;
}

function updateBadge(id, res) {
  const el = document.getElementById(id);
  const val = parseFloat(res.angle);
  if (res.type === 'Varo') {
    el.className = 'badge safe';
    el.innerText = 'Apertura (Varo)';
  } else if (val < 5 || res.type === 'Neutro') {
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

function generateClinicalReport(maxL, maxR) {
  const clinicalCard = document.getElementById('clinical-card');
  const clinFinding = document.getElementById('clin-finding');
  const clinRisk = document.getElementById('clin-risk');
  const clinRec = document.getElementById('clin-recommendation');

  clinicalCard.style.display = 'block';
  const peak = Math.max(maxL, maxR);
  let voiceMsg = "";

  if (peak > 12) {
    clinicalCard.style.borderLeftColor = 'var(--danger)';
    clinFinding.innerHTML = `<span style="color: var(--danger); font-weight: bold;">Colapso Medial Severo (${peak.toFixed(1)}° pico)</span>`;
    clinRisk.innerText = "Alto riesgo mecánico de sobrecarga del Ligamento Cruzado Anterior (LCA) e hiperpresión patelofemoral lateral.";
    clinRec.innerText = "Entrenamiento neuromuscular de glúteo medio/mayor, control pronador de retropié y reeducación cinemática con biofeedback.";
    voiceMsg = "Atención: Valgo dinámico severo detectado. Riesgo de sobrecarga ligamentosa y femoropatelar.";
  } else if (peak >= 5) {
    clinicalCard.style.borderLeftColor = 'var(--warning)';
    clinFinding.innerHTML = `<span style="color: var(--warning); font-weight: bold;">Valgo Dinámico Moderado (${peak.toFixed(1)}° pico)</span>`;
    clinRisk.innerText = "Compensación articular moderada. Mayor susceptibilidad a dolor femoropatelar y fatiga precoz de estabilizadores pélvicos.";
    clinRec.innerText = "Fortalecimiento excéntrico de cuádriceps alineado al 2do ortejo y activación abductora de cadera con banda elástica.";
    voiceMsg = "Valgo dinámico moderado detectado. Se sugiere corrección de la alineación de rodillas.";
  } else {
    clinicalCard.style.borderLeftColor = 'var(--success)';
    clinFinding.innerHTML = `<span style="color: var(--success); font-weight: bold;">Alineación Fisiológica Neutra (${peak.toFixed(1)}° pico)</span>`;
    clinRisk.innerText = "Cinemática frontal controlada. Vectores de carga fémoro-tibiales dentro de rangos fisiológicos óptimos.";
    clinRec.innerText = "Patrón motor adecuado. Progresar hacia sentadilla monopodal o ejercicios con aceleración/desaceleración.";
    voiceMsg = "Excelente ejecución. Alineación biomecánica neutra.";
  }

  speakFeedback(voiceMsg);
}

function addRepToTable(rep, maxL, maxR) {
  const table = document.getElementById('reps-table').querySelector('tbody');
  const row = table.insertRow();
  const maxPeak = Math.max(maxL, maxR);
  const risk = maxPeak > 12 ? 'Alto Riesgo' : maxPeak > 5 ? 'Moderado' : 'Bajo / Normal';
  row.innerHTML = `<td>#${rep}</td><td>${maxL.toFixed(1)}°</td><td>${maxR.toFixed(1)}°</td><td><strong>${risk}</strong></td>`;
}

// Botón: Evaluar 1 Sentadilla con cuenta regresiva
btnSingleSquat.addEventListener('click', () => {
  if (!cameraInstance) {
    alert('Primero debes presionar "Iniciar Cámara".');
    return;
  }

  evalState = 'COUNTDOWN';
  let counter = 3;
  countdownEl.style.display = 'block';
  countdownEl.innerText = counter;

  const timer = setInterval(() => {
    counter--;
    if (counter > 0) {
      countdownEl.innerText = counter;
    } else if (counter === 0) {
      countdownEl.innerText = '¡BAJA!';
    } else {
      clearInterval(timer);
      countdownEl.innerText = 'Realiza la sentadilla...';
      evalState = 'WAIT_DESCENT';
      peakValgusLeft = 0;
      peakValgusRight = 0;
      nadirKneeDistRatio = 100;
    }
  }, 1000);
});

// Botón: Nueva Evaluación
btnReset.addEventListener('click', () => {
  evalState = 'IDLE';
  countdownEl.style.display = 'none';
  btnReset.style.display = 'none';
  btnSingleSquat.style.display = 'inline-block';
  document.getElementById('clinical-card').style.display = 'none';
  document.getElementById('fppa-left').innerText = '0.0°';
  document.getElementById('fppa-right').innerText = '0.0°';
  document.getElementById('ratio-val').innerText = '100%';
});

// Inicialización de MediaPipe Pose
const pose = new Pose({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
});
pose.setOptions({
  modelComplexity: 2, // Modelo 'Heavy' de máxima precisión
  smoothLandmarks: true,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
});
pose.onResults(onResults);

// Encendido de la cámara
document.getElementById('btn-toggle-cam').addEventListener('click', async () => {
  if (!cameraInstance) {
    cameraInstance = new Camera(videoElement, {
      onFrame: async () => { await pose.send({ image: videoElement }); },
      width: 640,
      height: 480,
    });
    await cameraInstance.start();
    statusBadge.innerText = 'Cámara: Activa';
    statusBadge.style.background = '#15803d';
  }
});
