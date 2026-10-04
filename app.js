const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const countdownEl = document.getElementById('countdown-overlay');
const btnSingleSquat = document.getElementById('btn-single-squat');
const btnReset = document.getElementById('btn-reset-eval');
const statusBadge = document.getElementById('camera-status');

// Elementos del Modal de Instrucciones
const protocolModal = document.getElementById('protocol-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnConfirmProtocol = document.getElementById('btn-confirm-protocol');

// Elementos del Informe Integrado
const reportPlaceholder = document.getElementById('report-placeholder-text');
const reportContent = document.getElementById('report-content');
const reportStatusBadge = document.getElementById('report-status-badge');

let cameraInstance = null;
let repCount = 0;

// Máquina de estados
let evalState = 'IDLE'; 
let peakValgusLeft = 0;
let peakValgusRight = 0;
let nadirKneeDistRatio = 100;
let baselineHipY = null;

// Filtro EMA
let smoothL = 0;
let smoothR = 0;
const EMA_ALPHA = 0.4;

// FPS
let lastFrameTime = performance.now();
let frameCount = 0;
let fps = 0;

// Gráfica Chart.js
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

// Cálculo Biomecánico: FPPA y discriminación anatómica exacta
function calculateKneeKinematics(hipL, kneeL, ankleL, hipR, kneeR, ankleR) {
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

  const kneeDistance = Math.abs(kneeL.x - kneeR.x);
  const ankleDistance = Math.abs(ankleL.x - ankleR.x) || 1;

  const isMedialLeft = (hipL.x < hipR.x) ? (kneeL.x > hipL.x) : (kneeL.x < hipL.x);
  const isMedialRight = (hipR.x > hipL.x) ? (kneeR.x < hipR.x) : (kneeR.x > hipR.x);

  let typeL = 'Neutro';
  if (rawAngleL >= 3.0) typeL = isMedialLeft ? 'Valgo' : 'Varo';

  let typeR = 'Neutro';
  if (rawAngleR >= 3.0) typeR = isMedialRight ? 'Valgo' : 'Varo';

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

  // Dibujar articulaciones
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

  const kinematics = calculateKneeKinematics(lHip, lKnee, lAnkle, rHip, rKnee, rAnkle);

  smoothL = (EMA_ALPHA * kinematics.left.angle) + ((1 - EMA_ALPHA) * smoothL);
  smoothR = (EMA_ALPHA * kinematics.right.angle) + ((1 - EMA_ALPHA) * smoothR);

  const displayAngleL = parseFloat(smoothL.toFixed(1));
  const displayAngleR = parseFloat(smoothR.toFixed(1));

  document.getElementById('fppa-left').innerText = `${displayAngleL}° (${kinematics.left.type})`;
  document.getElementById('fppa-right').innerText = `${displayAngleR}° (${kinematics.right.type})`;
  updateBadge('badge-left', { angle: displayAngleL, type: kinematics.left.type });
  updateBadge('badge-right', { angle: displayAngleR, type: kinematics.right.type });
  document.getElementById('ratio-val').innerText = `${kinematics.ratio}%`;

  chart.data.datasets[0].data.shift();
  chart.data.datasets[0].data.push(kinematics.left.type === 'Valgo' ? displayAngleL : 0);
  chart.data.datasets[1].data.shift();
  chart.data.datasets[1].data.push(kinematics.right.type === 'Valgo' ? displayAngleR : 0);
  chart.update();

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

    if (currentHipY < baselineHipY + 0.03) {
      evalState = 'FINISHED';
      repCount++;
      showNotice('¡Evaluación Completa! ✅');
      btnReset.style.display = 'inline-block';
      btnSingleSquat.style.display = 'none';

      renderIntegratedReport(peakValgusLeft, peakValgusRight, nadirKneeDistRatio);
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

function renderIntegratedReport(maxL, maxR, minRatio) {
  reportPlaceholder.style.display = 'none';
  reportContent.style.display = 'block';

  document.getElementById('rep-val-left').innerText = `${maxL.toFixed(1)}°`;
  document.getElementById('rep-val-right').innerText = `${maxR.toFixed(1)}°`;
  document.getElementById('rep-val-ratio').innerText = `${minRatio}%`;

  const diff = Math.abs(maxL - maxR).toFixed(1);
  const asymBox = document.getElementById('rep-asymmetry');
  if (diff > 4.0) {
    const dominant = maxL > maxR ? 'Izquierda' : 'Derecha';
    asymBox.innerHTML = `<strong>Asimetría Bilateral Significativa:</strong> Diferencia de ${diff}° con mayor colapso en extremidad ${dominant}. Sugiere déficit unilateral de estabilidad lumbo-pélvica o tobillo.`;
    asymBox.style.borderLeftColor = 'var(--warning)';
  } else {
    asymBox.innerHTML = `<strong>Alineación Simétrica:</strong> Comportamiento bilateral homogéneo (diferencia de solo ${diff}°).`;
    asymBox.style.borderLeftColor = 'var(--cyan-accent)';
  }

  const maxPeak = Math.max(maxL, maxR);
  const riskBanner = document.getElementById('risk-banner');
  const riskTitle = document.getElementById('risk-title');
  const riskDesc = document.getElementById('risk-description');
  const lcaDetail = document.getElementById('detail-lca');
  const patellaDetail = document.getElementById('detail-patella');
  const interventionList = document.getElementById('intervention-list');

  let riskCategory = "";
  let voiceMsg = "";

  if (maxPeak > 12 || minRatio < 80) {
    riskCategory = "Alto Riesgo de Lesión";
    reportStatusBadge.innerText = "Resultado: Alto Riesgo";
    reportStatusBadge.style.background = "rgba(239, 68, 68, 0.2)";
    reportStatusBadge.style.color = "var(--danger)";

    riskBanner.style.background = "rgba(239, 68, 68, 0.1)";
    riskBanner.style.borderLeft = "4px solid var(--danger)";
    riskTitle.innerHTML = `<span style="color: var(--danger);">NIVEL DE RIESGO: ALTO (Colapso Severo > 12°)</span>`;
    riskDesc.innerText = "El sujeto presenta un colapso dinámico medial acentuado en el nadir. Este patrón incrementa críticamente los momentos de aducción y rotación interna de cadera acoplados.";

    lcaDetail.innerText = "Sobrecarga tensil pronunciada sobre el fascículo anteromedial del LCA por momento en valgo. Mayor vulnerabilidad ante gestos deportivos de desaceleración y pivote.";
    patellaDetail.innerText = "Vector en valgo aumentado: Desplazamiento lateral del tracking patelar, reduciendo el área de contacto y concentrando el estrés de contacto en la carilla lateral.";

    interventionList.innerHTML = `
      <li><strong>Fortalecimiento analítico:</strong> Glúteo medio (fibras posteriores) y glúteo mayor (abducción y rotación externa resistida con banda).</li>
      <li><strong>Control sensoriomotor:</strong> Sentadillas unipodales frente a espejo con biofeedback visual en tiempo real.</li>
      <li><strong>Evaluación de movilidad:</strong> Verificar restricción de dorsiflexión de tobillo (test lunge) que esté forzando pronación compensatoria.</li>
    `;
    voiceMsg = "Evaluación completa: Alto riesgo de valgo dinámico detectado.";

  } else if (maxPeak >= 5 || minRatio < 92) {
    riskCategory = "Riesgo Moderado";
    reportStatusBadge.innerText = "Resultado: Riesgo Moderado";
    reportStatusBadge.style.background = "rgba(234, 179, 8, 0.2)";
    reportStatusBadge.style.color = "var(--warning)";

    riskBanner.style.background = "rgba(234, 179, 8, 0.1)";
    riskBanner.style.borderLeft = "4px solid var(--warning)";
    riskTitle.innerHTML = `<span style="color: var(--warning);">NIVEL DE RIESGO: MODERADO (Desviación 5° a 12°)</span>`;
    riskDesc.innerText = "Patrón cinemático compensatorio leve a moderado. Adecuado en reposo pero vulnerable a fatiga en series repetitivas.";

    lcaDetail.innerText = "Tensión ligamentosa moderada dentro de límites submáximos pero con potencial lesivo acumulativo bajo fatiga excéntrica.";
    patellaDetail.innerText = "Ligera hiperpresión en el retináculo lateral patelar, compatible con molestias femoropadelares tempranas en deportistas.";

    interventionList.innerHTML = `
      <li><strong>Activación neuromuscular:</strong> Monster walks y puentes de glúteo con banda elástica antes de cargas pesadas.</li>
      <li><strong>Conciencia cinemática:</strong> Mantener rodilla alineada sobre el 2do ortejo durante todo el rango de movimiento.</li>
    `;
    voiceMsg = "Evaluación completa: Valgo moderado detectado.";

  } else {
    riskCategory = "Bajo Riesgo / Normal";
    reportStatusBadge.innerText = "Resultado: Óptimo";
    reportStatusBadge.style.background = "rgba(34, 197, 94, 0.2)";
    reportStatusBadge.style.color = "var(--success)";

    riskBanner.style.background = "rgba(34, 197, 94, 0.1)";
    riskBanner.style.borderLeft = "4px solid var(--success)";
    riskTitle.innerHTML = `<span style="color: var(--success);">NIVEL DE RIESGO: BAJO (Alineación Fisiológica)</span>`;
    riskDesc.innerText = "Cinemática frontal controlada. Los vectores de carga fémoro-tibiales se disipan axialmente de manera fisiológica.";

    lcaDetail.innerText = "Fuerzas de corte anteriores y momentos en valgo dentro de los rangos fisiológicos protegidos.";
    patellaDetail.innerText = "Tracking patelar congruente en la tróclea femoral sin sobrecargas por vectores de fuerza laterales.";

    interventionList.innerHTML = `
      <li><strong>Mantenimiento:</strong> Mantener la rutina motriz actual y progresar hacia gestos pliométricos o sentadilla unilateral.</li>
    `;
    voiceMsg = "Evaluación completa: Alineación óptima y bajo riesgo.";
  }

  const table = document.getElementById('reps-table').querySelector('tbody');
  const row = table.insertRow();
  row.innerHTML = `<td>#${repCount}</td><td>${maxL.toFixed(1)}°</td><td>${maxR.toFixed(1)}°</td><td>${minRatio}%</td><td><strong>${riskCategory}</strong></td>`;

  speakFeedback(voiceMsg);
}

// 1. Al presionar "Evaluar 1 Sentadilla", se muestra el modal con las instrucciones
btnSingleSquat.addEventListener('click', () => {
  if (!cameraInstance) {
    alert('Primero debes presionar "Iniciar Cámara".');
    return;
  }
  protocolModal.style.display = 'flex';
  speakFeedback("Revisa las instrucciones en pantalla antes de iniciar.");
});

// 2. Al confirmar "¡Listo, empezar cuenta regresiva!", se cierra el modal y corre el temporizador
btnConfirmProtocol.addEventListener('click', () => {
  protocolModal.style.display = 'none';

  speakFeedback("Prepárate. Brazos al pecho y pies al ancho de hombros.");

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
      speakFeedback("Baja");
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

// Botón de cierre manual del modal
btnCloseModal.addEventListener('click', () => {
  protocolModal.style.display = 'none';
});

// Botón para nueva evaluación
btnReset.addEventListener('click', () => {
  evalState = 'IDLE';
  countdownEl.style.display = 'none';
  btnReset.style.display = 'none';
  btnSingleSquat.style.display = 'inline-block';
  document.getElementById('fppa-left').innerText = '0.0°';
  document.getElementById('fppa-right').innerText = '0.0°';
  document.getElementById('ratio-val').innerText = '100%';
});

// Inicializar MediaPipe
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

// Encendido de cámara
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
