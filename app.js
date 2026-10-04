const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const countdownEl = document.getElementById('countdown-overlay');
const btnSingleSquat = document.getElementById('btn-single-squat');
const btnReset = document.getElementById('btn-reset-eval');
const statusBadge = document.getElementById('camera-status');

let cameraInstance = null;
let repCount = 0;

// Máquina de estados
let evalState = 'IDLE'; 
let peakValgusLeft = 0;
let peakValgusRight = 0;
let nadirKneeDistRatio = 100;
let baselineHipY = null;

// Filtro de suavizado EMA (elimina temblores sin retrasar la respuesta)
let smoothL = 0;
let smoothR = 0;
const EMA_ALPHA = 0.4;

// Monitoreo de FPS
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

function speakFeedback(text) {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-CL';
    utterance.rate = 1.0;
    window.speechSynthesis.speak(utterance);
  }
}

// CÁLCULO DIRECTO E INFALIBLE DE VALGO VS VARO
// Compara la posición de la rodilla respecto a la línea entre su propia cadera y el centro entre tobillos
function calculateKneeKinematics(hipL, kneeL, ankleL, hipR, kneeR, ankleR) {
  // 1. Ángulo FPPA clásico (desviación de 180° en la línea cadera-rodilla-tobillo)
  function getAngle(hip, knee, ankle) {
    const v1 = { x: hip.x - knee.x, y: hip.y - knee.y };
    const v2 = { x: ankle.x - knee.x, y: ankle.y - knee.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const mag1 = Math.hypot(v1.x, v1.y);
    const mag2 = Math.hypot(v2.x, v2.y);
    if (mag1 === 0 || mag2 === 0) return 0;
    const rad = Math.acos(Math.min(Math.max(dot / (mag1 * mag2), -1.0), 1.0));
    return Math.abs(180 - (rad * (180 / Math.PI)));
  }

  const rawAngleL = getAngle(hipL, kneeL, ankleL);
  const rawAngleR = getAngle(hipR, kneeR, ankleR);

  // 2. Discriminación de dirección física (adentro vs afuera)
  // En MediaPipe, el Landmark 23 es Cadera Izquierda y 24 es Cadera Derecha del sujeto.
  // Calculamos la distancia entre rodillas y la distancia entre caderas/tobillos
  const kneeDistance = Math.abs(kneeL.x - kneeR.x);
  const ankleDistance = Math.abs(ankleL.x - ankleR.x) || 1;
  const hipDistance = Math.abs(hipL.x - hipR.x) || 1;

  // Si la rodilla izquierda se mueve hacia la derecha (hacia la otra pierna), es VALGO
  // La rodilla izquierda es medial si está más cerca de la rodilla opuesta que su cadera
  // REGLA DIRECTA: Si la rodilla de ese lado invade el espacio medial hacia la otra rodilla:
  const isMedialLeft = (hipL.x < hipR.x) ? (kneeL.x > hipL.x) : (kneeL.x < hipL.x);
  const isMedialRight = (hipR.x > hipL.x) ? (kneeR.x < hipR.x) : (kneeR.x > hipR.x);

  let typeL = 'Neutro';
  if (rawAngleL >= 3.0) {
    typeL = isMedialLeft ? 'Valgo' : 'Varo';
  }

  let typeR = 'Neutro';
  if (rawAngleR >= 3.0) {
    typeR = isMedialRight ? 'Valgo' : 'Varo';
  }

  // Comprobación de seguridad adicional:
  // Si la distancia entre rodillas es menor que la distancia entre tobillos, OBLIGATORIAMENTE hay colapso en valgo
  if (kneeDistance < ankleDistance * 0.95) {
    if (rawAngleL >= 3.0) typeL = 'Valgo';
    if (rawAngleR >= 3.0) typeR = 'Valgo';
  }

  return {
    left: { angle: rawAngleL, type: typeL },
    right: { angle: rawAngleR, type: typeR },
    ratio: Math.round((kneeDistance / ankleDistance) * 100)
  };
}

function onResults(results) {
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

  if (evalState === 'FINISHED') {
    canvasCtx.restore();
    return;
  }

  if ((lKnee.visibility && lKnee.visibility < 0.45) || (rKnee.visibility && rKnee.visibility < 0.45)) {
    canvasCtx.restore();
    return;
  }

  // Dibujar puntos
  [lHip, rHip, lKnee, rKnee, lAnkle, rAnkle].forEach(pt => {
    canvasCtx.beginPath();
    canvasCtx.arc(pt.x * canvasElement.width, pt.y * canvasElement.height, 6, 0, 2 * Math.PI);
    canvasCtx.fillStyle = '#06b6d4';
    canvasCtx.fill();
  });

  // Conectar segmentos
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

  // Ejecutar cálculo biomecánico blindado
  const kinematics = calculateKneeKinematics(lHip, lKnee, lAnkle, rHip, rKnee, rAnkle);

  // Filtro EMA para suavizar
  smoothL = (EMA_ALPHA * kinematics.left.angle) + ((1 - EMA_ALPHA) * smoothL);
  smoothR = (EMA_ALPHA * kinematics.right.angle) + ((1 - EMA_ALPHA) * smoothR);

  const displayAngleL = parseFloat(smoothL.toFixed(1));
  const displayAngleR = parseFloat(smoothR.toFixed(1));

  document.getElementById('fppa-left').innerText = `${displayAngleL}° (${kinematics.left.type})`;
  document.getElementById('fppa-right').innerText = `${displayAngleR}° (${kinematics.right.type})`;
  updateBadge('badge-left', { angle: displayAngleL, type: kinematics.left.type });
  updateBadge('badge-right', { angle: displayAngleR, type: kinematics.right.type });

  document.getElementById('ratio-val').innerText = `${kinematics.ratio}%`;

  // Gráfica dinámica
  chart.data.datasets[0].data.shift();
  chart.data.datasets[0].data.push(kinematics.left.type === 'Valgo' ? displayAngleL : 0);
  chart.data.datasets[1].data.shift();
  chart.data.datasets[1].data.push(kinematics.right.type === 'Valgo' ? displayAngleR : 0);
  chart.update();

  // Detección automática del nadir de sentadilla
  const currentHipY = (lHip.y + rHip.y) / 2;

  if (evalState === 'WAIT_DESCENT') {
    baselineHipY = currentHipY;
    if (currentHipY > baselineHipY + 0.04) {
      evalState = 'RECORDING';
      showNotice('¡Descendiendo! Controla las rodillas...');
    }
  } else if (evalState === 'RECORDING') {
    if (kinematics.left.type === 'Valgo' && displayAngleL > peakValgusLeft) peakValgusLeft = displayAngleL;
    if (kinematics.right.type === 'Valgo' && displayAngleR > peakValgusRight) peakValgusRight = displayAngleR;
    if (kinematics.ratio < nadirKneeDistRatio) nadirKneeDistRatio = kinematics.ratio;

    // Retorno a posición erguida
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
    clinRec.innerText = "Entrenamiento neuromuscular de glúteo medio/mayor, control pronador de retropié y reeducación motriz con biofeedback.";
    voiceMsg = "Atención: Valgo dinámico severo detectado. Riesgo de sobrecarga ligamentosa y femoropatelar.";
  } else if (peak >= 5) {
    clinicalCard.style.borderLeftColor = 'var(--warning)';
    clinFinding.innerHTML = `<span style="color: var(--warning); font-weight: bold;">Valgo Dinámico Moderado (${peak.toFixed(1)}° pico)</span>`;
    clinRisk.innerText = "Compensación articular moderada. Mayor susceptibilidad a dolor femoropatelar y fatiga precoz de estabilizadores pélvicos.";
    clinRec.innerText = "Fortalecimiento excéntrico de cuádriceps alineado al segundo ortejo y activación abductora de cadera con banda elástica.";
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

// Botón de evaluación
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

// Botón para reiniciar
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

// MediaPipe Pose
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

// Botón cámara
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
