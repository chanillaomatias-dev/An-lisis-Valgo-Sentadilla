// =====================================================================
// DKV Screening Tool — Valgo Dinámico de Rodilla (sentadilla bipodal)
// Versión con marcado de repeticiones en el eje X de la Curva Cinemática
// =====================================================================

const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const countdownEl = document.getElementById('countdown-overlay');
const btnSingleSquat = document.getElementById('btn-single-squat');
const btnReset = document.getElementById('btn-reset-eval');
const statusBadge = document.getElementById('camera-status');

// Modal de instrucciones
const protocolModal = document.getElementById('protocol-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnConfirmProtocol = document.getElementById('btn-confirm-protocol');

// Informe integrado
const reportPlaceholder = document.getElementById('report-placeholder-text');
const reportContent = document.getElementById('report-content');
const reportStatusBadge = document.getElementById('report-status-badge');

// ---------------------------------------------------------------------
// Parámetros
// ---------------------------------------------------------------------
const FPPA_MODERATE = 5;      // ° -> desde aquí: valgo moderado
const FPPA_SEVERE = 12;       // ° -> sobre esto: colapso medial severo
const KA_HIGH = 80;           // % ratio K/A bajo el cual hay riesgo alto
const KA_MODERATE = 92;       // % ratio K/A bajo el cual hay riesgo moderado
const TYPE_DEADBAND = 3;      // ° -> bajo esto se considera alineación neutra
const EMA_ALPHA = 0.35;       // filtro paso bajo exponencial
const MIN_VISIBILITY = 0.5;   // visibilidad mínima de los 6 landmarks

// Segmentación temporal
const DESCENT_START = 0.08;   // caída de cadera que marca el inicio del descenso
const DESCENT_END = 0.04;     // subida completa
const MIN_DEPTH = 0.15;       // profundidad mínima para sentadilla válida
const DEEP_PHASE = 0.6;       // fase profunda del nadir
const MEDIAN_WINDOW = 5;      // ventana filtro mediana
const MAX_REC_MS = 15000;     // tiempo máximo por repetición
const BASELINE_FRAMES = 45;   // cuadros para referencia
const MIN_BASELINE_FRAMES = 10;
const REPS_PER_SET = 5;      // repeticiones por serie
const COUNTDOWN_SECONDS = 5; // cuenta regresiva inicial
const BUFFER_SIZE = 50;      // ancho de la ventana gráfica en tiempo real

// ---------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------
let cameraInstance = null;
let repCount = 0;

// IDLE -> COUNTDOWN -> WAIT_DESCENT -> RECORDING -> FINISHED
let evalState = 'IDLE';

let smoothL = null;
let smoothR = null;

let baselineBuf = [];
let baseline = null;
let recSamples = [];
let maxDrop = 0;
let recStart = 0;
let setResults = [];
let pendingRepLabel = null; // Etiqueta para marcar la repetición en el eje X

// FPS
let lastFrameTime = performance.now();
let frameCount = 0;
let fps = 0;

// ---------------------------------------------------------------------
// Gráfica Cinemática Continua con Eje X visible y marcas de repetición
// ---------------------------------------------------------------------
const ctxChart = document.getElementById('kinematicsChart').getContext('2d');
const chart = new Chart(ctxChart, {
  type: 'line',
  data: {
    labels: Array(BUFFER_SIZE).fill(''),
    datasets: [
      {
        label: 'FPPA Izq (°)',
        data: Array(BUFFER_SIZE).fill(0),
        borderColor: '#06b6d4',
        borderWidth: 2,
        fill: false,
        pointRadius: 0
      },
      {
        label: 'FPPA Der (°)',
        data: Array(BUFFER_SIZE).fill(0),
        borderColor: '#f43f5e',
        borderWidth: 2,
        fill: false,
        pointRadius: 0
      }
    ]
  },
  options: {
    responsive: true,
    animation: false,
    scales: {
      y: {
        min: -10,
        max: 25,
        title: {
          display: true,
          text: 'Ángulo FPPA (°)',
          color: '#94a3b8',
          font: { size: 10 }
        },
        grid: { color: '#1f2937' },
        ticks: { color: '#94a3b8', font: { size: 9 } }
      },
      x: {
        display: true,
        title: {
          display: true,
          text: 'Ciclo / Repetición evaluada',
          color: '#06b6d4',
          font: { size: 10, weight: 'bold' }
        },
        grid: {
          color: (ctx) => {
            // Línea de cuadrícula vertical destacada cuando hay etiqueta de repetición
            const label = ctx.chart.data.labels[ctx.index];
            return (label && label.startsWith('Rep')) ? 'rgba(6, 182, 212, 0.45)' : '#111827';
          }
        },
        ticks: {
          color: '#38bdf8',
          font: { size: 10, weight: 'bold' },
          autoSkip: false,
          maxRotation: 0
        }
      }
    },
    plugins: {
      legend: {
        labels: { color: '#cbd5e1', font: { size: 10 } }
      }
    }
  }
});

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
function speakFeedback(text) {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-CL';
    utterance.rate = 1.0;
    window.speechSynthesis.speak(utterance);
  }
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function medianFilter(arr, win) {
  const half = Math.floor(win / 2);
  return arr.map((_, i) => {
    const from = Math.max(0, i - half);
    const to = Math.min(arr.length, i + half + 1);
    return median(arr.slice(from, to));
  });
}

function classifyType(s) {
  if (s >= TYPE_DEADBAND) return 'Valgo';
  if (s <= -TYPE_DEADBAND) return 'Varo';
  return 'Neutro';
}

function signedFPPA(hip, knee, ankle, medialSign) {
  const tx = (knee.x - hip.x) * medialSign;
  const ty = knee.y - hip.y;
  const sx = (ankle.x - knee.x) * medialSign;
  const sy = ankle.y - knee.y;
  const thigh = Math.atan2(tx, ty);
  const shank = Math.atan2(sx, sy);
  return (thigh - shank) * 180 / Math.PI;
}

function calculateKneeKinematics(hipL, kneeL, ankleL, hipR, kneeR, ankleR) {
  if (Math.abs(hipL.x - hipR.x) < 1) return null;

  const midX = (hipL.x + hipR.x) / 2;
  const mL = Math.sign(midX - hipL.x) || 1;
  const mR = Math.sign(midX - hipR.x) || 1;

  const fL = signedFPPA(hipL, kneeL, ankleL, mL);
  const fR = signedFPPA(hipR, kneeR, ankleR, mR);

  const kneeDist = Math.abs(kneeL.x - kneeR.x);
  const ankleDist = Math.abs(ankleL.x - ankleR.x);
  const ratio = ankleDist > 1 ? Math.round((kneeDist / ankleDist) * 100) : 100;

  return { left: fL, right: fR, ratio };
}

// ---------------------------------------------------------------------
// Procesamiento cuadro por cuadro
// ---------------------------------------------------------------------
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

  const w = canvasElement.width;
  const h = canvasElement.height;
  const lm = results.poseLandmarks;

  const needed = [23, 24, 25, 26, 27, 28];
  if (needed.some(i => (lm[i].visibility ?? 1) < MIN_VISIBILITY)) {
    canvasCtx.restore();
    return;
  }

  const px = (p) => ({ x: p.x * w, y: p.y * h });
  const lHip = px(lm[23]), rHip = px(lm[24]);
  const lKnee = px(lm[25]), rKnee = px(lm[26]);
  const lAnkle = px(lm[27]), rAnkle = px(lm[28]);

  // Dibujo del esqueleto
  [lHip, rHip, lKnee, rKnee, lAnkle, rAnkle].forEach(pt => {
    canvasCtx.beginPath();
    canvasCtx.arc(pt.x, pt.y, 6, 0, 2 * Math.PI);
    canvasCtx.fillStyle = '#06b6d4';
    canvasCtx.fill();
  });
  canvasCtx.strokeStyle = '#38bdf8';
  canvasCtx.lineWidth = 3;
  const drawLine = (p1, p2) => {
    canvasCtx.beginPath();
    canvasCtx.moveTo(p1.x, p1.y);
    canvasCtx.lineTo(p2.x, p2.y);
    canvasCtx.stroke();
  };
  drawLine(lHip, lKnee); drawLine(lKnee, lAnkle);
  drawLine(rHip, rKnee); drawLine(rKnee, rAnkle);

  if (evalState === 'FINISHED') {
    canvasCtx.restore();
    return;
  }

  const kin = calculateKneeKinematics(lHip, lKnee, lAnkle, rHip, rKnee, rAnkle);
  if (!kin) {
    canvasCtx.restore();
    return;
  }

  // Filtrado EMA
  smoothL = smoothL === null ? kin.left : (EMA_ALPHA * kin.left + (1 - EMA_ALPHA) * smoothL);
  smoothR = smoothR === null ? kin.right : (EMA_ALPHA * kin.right + (1 - EMA_ALPHA) * smoothR);

  const typeL = classifyType(smoothL);
  const typeR = classifyType(smoothR);

  document.getElementById('fppa-left').innerText = `${Math.abs(smoothL).toFixed(1)}° (${typeL})`;
  document.getElementById('fppa-right').innerText = `${Math.abs(smoothR).toFixed(1)}° (${typeR})`;
  updateBadge('badge-left', smoothL);
  updateBadge('badge-right', smoothR);
  document.getElementById('ratio-val').innerText = `${kin.ratio}%`;

  // Actualización de la gráfica con etiqueta en eje X si corresponde
  chart.data.datasets[0].data.shift();
  chart.data.datasets[0].data.push(parseFloat(smoothL.toFixed(1)));
  chart.data.datasets[1].data.shift();
  chart.data.datasets[1].data.push(parseFloat(smoothR.toFixed(1)));

  chart.data.labels.shift();
  if (pendingRepLabel) {
    chart.data.labels.push(pendingRepLabel);
    pendingRepLabel = null; // consumida
  } else {
    chart.data.labels.push('');
  }
  chart.update('none');

  // Normalización corporal
  const hipMidY = (lHip.y + rHip.y) / 2;
  const ankleMidY = (lAnkle.y + rAnkle.y) / 2;
  const legLen = ankleMidY - hipMidY;

  if (legLen > 1) {
    if (evalState === 'COUNTDOWN' || evalState === 'WAIT_DESCENT') {
      const dropNow = baseline ? (hipMidY - baseline.hipY) / baseline.legLen : 0;
      if (!baseline || dropNow < DESCENT_START * 0.5) {
        baselineBuf.push({ hipY: hipMidY, legLen, fL: smoothL, fR: smoothR, ratio: kin.ratio });
        if (baselineBuf.length > BASELINE_FRAMES) baselineBuf.shift();
        if (baselineBuf.length >= MIN_BASELINE_FRAMES) {
          baseline = {
            hipY: median(baselineBuf.map(b => b.hipY)),
            legLen: median(baselineBuf.map(b => b.legLen)),
            fL: median(baselineBuf.map(b => b.fL)),
            fR: median(baselineBuf.map(b => b.fR)),
            ratio: median(baselineBuf.map(b => b.ratio))
          };
        }
      }

      // Inicio del descenso: marcar repetición en el eje X
      if (evalState === 'WAIT_DESCENT' && baseline && dropNow > DESCENT_START) {
        evalState = 'RECORDING';
        recSamples = [];
        maxDrop = 0;
        recStart = now;
        pendingRepLabel = `Rep ${repCount + 1}`;
        showNotice(`¡Descendiendo (Rep ${repCount + 1})! Controla las rodillas...`);
      }
    }

    if (evalState === 'RECORDING' && baseline) {
      const drop = (hipMidY - baseline.hipY) / baseline.legLen;
      recSamples.push({ drop, fL: smoothL, fR: smoothR, ratio: kin.ratio });
      if (drop > maxDrop) maxDrop = drop;

      const returned = drop < DESCENT_END && maxDrop >= MIN_DEPTH;
      const timedOut = (now - recStart) > MAX_REC_MS;

      if (returned || (timedOut && maxDrop >= MIN_DEPTH && recSamples.length >= 10)) {
        finishEvaluation();
      } else if (timedOut) {
        evalState = 'WAIT_DESCENT';
        recSamples = [];
        maxDrop = 0;
        showNotice('No se detectó una sentadilla completa. Intenta de nuevo.');
      }
    }
  }

  canvasCtx.restore();
}

// ---------------------------------------------------------------------
// Cálculos de repetición y resumen
// ---------------------------------------------------------------------
function computeResults(samples) {
  const maxD = Math.max(...samples.map(s => s.drop));
  let win = samples.filter(s => s.drop >= DEEP_PHASE * maxD);
  if (win.length < 3) win = samples;

  const fL = medianFilter(win.map(s => s.fL), MEDIAN_WINDOW);
  const fR = medianFilter(win.map(s => s.fR), MEDIAN_WINDOW);
  const ra = medianFilter(win.map(s => s.ratio), MEDIAN_WINDOW);

  return {
    peakL: Math.max(0, Math.max(...fL)),
    peakR: Math.max(0, Math.max(...fR)),
    minRatio: Math.round(Math.min(...ra))
  };
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1));
}

function riskCategoryOf(maxL, maxR, minRatio) {
  const maxPeak = Math.max(maxL, maxR);
  const valgusConfirmed = maxPeak >= TYPE_DEADBAND;
  if (maxPeak > FPPA_SEVERE || (valgusConfirmed && minRatio < KA_HIGH)) return 'Alto Riesgo de Lesión';
  if (maxPeak >= FPPA_MODERATE || (valgusConfirmed && minRatio < KA_MODERATE)) return 'Riesgo Moderado';
  return 'Bajo Riesgo / Normal';
}

function addRepRow(n, res) {
  const tbody = document.getElementById('reps-table').querySelector('tbody');
  const row = tbody.insertRow();
  row.innerHTML = `<td>#${n}</td><td>${res.peakL.toFixed(1)}°</td><td>${res.peakR.toFixed(1)}°</td><td>${res.minRatio}%</td><td>${riskCategoryOf(res.peakL, res.peakR, res.minRatio)}</td>`;
}

function finishEvaluation() {
  const res = computeResults(recSamples);
  repCount++;
  setResults.push(res);
  addRepRow(repCount, res);
  recSamples = [];
  maxDrop = 0;

  if (repCount < REPS_PER_SET) {
    evalState = 'WAIT_DESCENT';
    btnReset.style.display = 'inline-block';
    showNotice(`Repetición ${repCount}/${REPS_PER_SET} ✅ — vuelve a bajar`);
    speakFeedback(`Repetición ${repCount}. Otra vez.`);
    return;
  }

  evalState = 'FINISHED';
  showNotice(`¡Evaluación completa (${REPS_PER_SET} repeticiones)! ✅`);
  btnReset.style.display = 'inline-block';
  btnSingleSquat.style.display = 'none';

  const pL = setResults.map(r => r.peakL);
  const pR = setResults.map(r => r.peakR);
  const kas = setResults.map(r => r.minRatio);
  renderIntegratedReport(mean(pL), mean(pR), Math.round(mean(kas)), {
    n: setResults.length,
    sdL: stdDev(pL),
    sdR: stdDev(pR)
  });
}

function showNotice(text) {
  countdownEl.style.display = 'block';
  countdownEl.innerText = text;
}

function updateBadge(id, s) {
  const el = document.getElementById(id);
  if (s <= -FPPA_MODERATE) {
    el.className = 'badge safe';
    el.innerText = 'Apertura (Varo)';
  } else if (s < FPPA_MODERATE) {
    el.className = 'badge safe';
    el.innerText = 'Alineación Normal';
  } else if (s <= FPPA_SEVERE) {
    el.className = 'badge moderate';
    el.innerText = 'Valgo Leve/Mod.';
  } else {
    el.className = 'badge risk';
    el.innerText = 'Alto Valgo (Riesgo)';
  }
}

function renderIntegratedReport(maxL, maxR, minRatio, stats) {
  reportPlaceholder.style.display = 'none';
  reportContent.style.display = 'block';

  document.getElementById('rep-val-left').innerText = `${maxL.toFixed(1)}°`;
  document.getElementById('rep-val-right').innerText = `${maxR.toFixed(1)}°`;
  document.getElementById('rep-val-ratio').innerText = `${minRatio}%`;

  const diff = Math.abs(maxL - maxR);
  const diffTxt = diff.toFixed(1);
  const asymBox = document.getElementById('rep-asymmetry');

  let baseNote = '';
  if (baseline) {
    baseNote = `<br><small>FPPA en bipedestación (referencia): Izq ${baseline.fL.toFixed(1)}° / Der ${baseline.fR.toFixed(1)}° · K/A inicial ${Math.round(baseline.ratio)}%</small>`;
  }

  if (stats) {
    const sdMax = Math.max(stats.sdL, stats.sdR);
    const consist = sdMax > 3
      ? ' ⚠️ Alta variabilidad entre repeticiones: interpretar con cautela.'
      : ' Patrón consistente entre repeticiones.';
    baseNote += `<br><small>Promedio de ${stats.n} repeticiones · Variabilidad (DE): Izq ${stats.sdL.toFixed(1)}° / Der ${stats.sdR.toFixed(1)}°.${consist}</small>`;
  }

  if (diff > 4.0) {
    const dominant = maxL > maxR ? 'Izquierda' : 'Derecha';
    asymBox.innerHTML = `<strong>Asimetría Bilateral Significativa:</strong> Diferencia de ${diffTxt}° con mayor colapso en extremidad ${dominant}. Sugiere déficit unilateral de estabilidad lumbo-pélvica o tobillo.${baseNote}`;
    asymBox.style.borderLeftColor = 'var(--warning)';
  } else {
    asymBox.innerHTML = `<strong>Alineación Simétrica:</strong> Comportamiento bilateral homogéneo (diferencia de solo ${diffTxt}°).${baseNote}`;
    asymBox.style.borderLeftColor = 'var(--cyan-accent)';
  }

  const maxPeak = Math.max(maxL, maxR);
  const valgusConfirmed = maxPeak >= TYPE_DEADBAND;

  const riskBanner = document.getElementById('risk-banner');
  const riskTitle = document.getElementById('risk-title');
  const riskDesc = document.getElementById('risk-description');
  const lcaDetail = document.getElementById('detail-lca');
  const patellaDetail = document.getElementById('detail-patella');
  const interventionList = document.getElementById('intervention-list');

  let riskCategory = '';
  let voiceMsg = '';

  if (maxPeak > FPPA_SEVERE || (valgusConfirmed && minRatio < KA_HIGH)) {
    riskCategory = 'Alto Riesgo de Lesión';
    reportStatusBadge.innerText = 'Resultado: Alto Riesgo';
    reportStatusBadge.style.background = 'rgba(239, 68, 68, 0.2)';
    reportStatusBadge.style.color = 'var(--danger)';

    riskBanner.style.background = 'rgba(239, 68, 68, 0.1)';
    riskBanner.style.borderLeft = '4px solid var(--danger)';
    riskTitle.innerHTML = `<span style="color: var(--danger);">NIVEL DE RIESGO: ALTO (Colapso Severo > 12°)</span>`;
    riskDesc.innerText = 'El sujeto presenta un colapso dinámico medial acentuado en el nadir. Este patrón incrementa críticamente los momentos de aducción y rotación interna de cadera acoplados.';

    lcaDetail.innerText = 'Sobrecarga tensil pronunciada sobre el fascículo anteromedial del LCA por momento en valgo. Mayor vulnerabilidad ante gestos deportivos de desaceleración y pivote.';
    patellaDetail.innerText = 'Vector en valgo aumentado: Desplazamiento lateral del tracking patelar, reduciendo el área de contacto y concentrando el estrés de contacto en la carilla lateral.';

    interventionList.innerHTML = `
      <li><strong>Fortalecimiento analítico:</strong> Glúteo medio (fibras posteriores) y glúteo mayor (abducción y rotación externa resistida con banda).</li>
      <li><strong>Control sensoriomotor:</strong> Sentadillas unipodales frente a espejo con biofeedback visual en tiempo real.</li>
      <li><strong>Evaluación de movilidad:</strong> Verificar restricción de dorsiflexión de tobillo (test lunge) que esté forzando pronación compensatoria.</li>
    `;
    voiceMsg = 'Evaluación completa: Alto riesgo de valgo dinámico detectado.';

  } else if (maxPeak >= FPPA_MODERATE || (valgusConfirmed && minRatio < KA_MODERATE)) {
    riskCategory = 'Riesgo Moderado';
    reportStatusBadge.innerText = 'Resultado: Riesgo Moderado';
    reportStatusBadge.style.background = 'rgba(234, 179, 8, 0.2)';
    reportStatusBadge.style.color = 'var(--warning)';

    riskBanner.style.background = 'rgba(234, 179, 8, 0.1)';
    riskBanner.style.borderLeft = '4px solid var(--warning)';
    riskTitle.innerHTML = `<span style="color: var(--warning);">NIVEL DE RIESGO: MODERADO (Desviación 5° a 12°)</span>`;
    riskDesc.innerText = 'Patrón cinemático compensatorio leve a moderado. Adecuado en reposo pero vulnerable a fatiga en series repetitivas.';

    lcaDetail.innerText = 'Tensión ligamentosa moderada dentro de límites submáximos pero con potencial lesivo acumulativo bajo fatiga excéntrica.';
    patellaDetail.innerText = 'Ligera hiperpresión en el retináculo lateral patelar, compatible con molestias femoropatelares tempranas en deportistas.';

    interventionList.innerHTML = `
      <li><strong>Activación neuromuscular:</strong> Monster walks y puentes de glúteo con banda elástica antes de cargas pesadas.</li>
      <li><strong>Conciencia cinemática:</strong> Mantener rodilla alineada sobre el 2do ortejo durante todo el rango de movimiento.</li>
    `;
    voiceMsg = 'Evaluación completa: Valgo moderado detectado.';

  } else {
    riskCategory = 'Bajo Riesgo / Normal';
    reportStatusBadge.innerText = 'Resultado: Óptimo';
    reportStatusBadge.style.background = 'rgba(34, 197, 94, 0.2)';
    reportStatusBadge.style.color = 'var(--success)';

    riskBanner.style.background = 'rgba(34, 197, 94, 0.1)';
    riskBanner.style.borderLeft = '4px solid var(--success)';
    riskTitle.innerHTML = `<span style="color: var(--success);">NIVEL DE RIESGO: BAJO (Alineación Fisiológica)</span>`;
    riskDesc.innerText = 'Cinemática frontal controlada. Los vectores de carga fémoro-tibiales se disipan axialmente de manera fisiológica.';

    lcaDetail.innerText = 'Fuerzas de corte anteriores y momentos en valgo dentro de los rangos fisiológicos protegidos.';
    patellaDetail.innerText = 'Tracking patelar congruente en la tróclea femoral sin sobrecargas por vectores de fuerza laterales.';

    interventionList.innerHTML = `
      <li><strong>Mantenimiento:</strong> Mantener la rutina motriz actual y progresar hacia gestos pliométricos o sentadilla unilateral.</li>
    `;
    voiceMsg = 'Evaluación completa: Alineación óptima y bajo riesgo.';
  }

  const table = document.getElementById('reps-table').querySelector('tbody');
  const row = table.insertRow();
  row.innerHTML = `<td><strong>Prom.</strong></td><td><strong>${maxL.toFixed(1)}°</strong></td><td><strong>${maxR.toFixed(1)}°</strong></td><td><strong>${minRatio}%</strong></td><td><strong>${riskCategory}</strong></td>`;

  speakFeedback(voiceMsg);
}

// ---------------------------------------------------------------------
// Controles y Reinicio
// ---------------------------------------------------------------------
function resetEvaluationData() {
  baselineBuf = [];
  baseline = null;
  recSamples = [];
  maxDrop = 0;
  smoothL = null;
  smoothR = null;
  setResults = [];
  repCount = 0;
  pendingRepLabel = null;
  document.getElementById('reps-table').querySelector('tbody').innerHTML = '';

  // Limpiar curva cinemática
  chart.data.labels = Array(BUFFER_SIZE).fill('');
  chart.data.datasets[0].data = Array(BUFFER_SIZE).fill(0);
  chart.data.datasets[1].data = Array(BUFFER_SIZE).fill(0);
  chart.update();
}

btnSingleSquat.addEventListener('click', () => {
  if (!cameraInstance) {
    alert('Primero debes presionar "Iniciar Cámara".');
    return;
  }
  protocolModal.style.display = 'flex';
  speakFeedback('Revisa las instrucciones en pantalla antes de iniciar.');
});

btnConfirmProtocol.addEventListener('click', () => {
  protocolModal.style.display = 'none';
  speakFeedback('Prepárate. Brazos al pecho y pies al ancho de hombros.');

  resetEvaluationData();
  evalState = 'COUNTDOWN';

  let counter = COUNTDOWN_SECONDS;
  countdownEl.style.display = 'block';
  countdownEl.innerText = counter;

  const timer = setInterval(() => {
    counter--;
    if (counter > 0) {
      countdownEl.innerText = counter;
    } else {
      clearInterval(timer);
      countdownEl.innerText = '¡BAJA!';
      speakFeedback('Baja');
      evalState = 'WAIT_DESCENT';
      setTimeout(() => {
        if (evalState === 'WAIT_DESCENT') countdownEl.innerText = `Realiza ${REPS_PER_SET} sentadillas seguidas...`;
      }, 1200);
    }
  }, 1000);
});

btnCloseModal.addEventListener('click', () => {
  protocolModal.style.display = 'none';
});

btnReset.addEventListener('click', () => {
  evalState = 'IDLE';
  resetEvaluationData();
  countdownEl.style.display = 'none';
  btnReset.style.display = 'none';
  btnSingleSquat.style.display = 'inline-block';
  document.getElementById('fppa-left').innerText = '0.0°';
  document.getElementById('fppa-right').innerText = '0.0°';
  document.getElementById('ratio-val').innerText = '100%';
});

// ---------------------------------------------------------------------
// MediaPipe Pose
// ---------------------------------------------------------------------
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
    statusBadge.innerText = 'Cámara: Activa';
    statusBadge.style.background = '#15803d';
  }
});

// Ajuste dinámico de textos
btnSingleSquat.innerText = `🎯 Evaluar ${REPS_PER_SET} Sentadillas`;
reportPlaceholder.innerHTML = `Presione <strong>"🎯 Evaluar ${REPS_PER_SET} Sentadillas"</strong>, siga las instrucciones de posicionamiento en pantalla y realice ${REPS_PER_SET} sentadillas seguidas para obtener el promedio, la variabilidad y las sugerencias kinesiológicas.`;
const protocolItems = document.querySelectorAll('.protocol-item');
if (protocolItems[0]) {
  protocolItems[0].querySelector('p').innerHTML = `Aléjate a <strong>2.0 - 2.5 metros</strong> de la cámara: son aproximadamente <strong>3 a 4 pasos normales hacia atrás</strong> desde la pantalla. Deben verse completos tus <strong>pies, rodillas y caderas</strong>.`;
}
if (protocolItems[3]) {
  protocolItems[3].querySelector('h4').innerText = 'Subida y repeticiones';
  protocolItems[3].querySelector('p').innerHTML = `Vuelve a subir a la posición erguida y <strong>repite el movimiento de forma continua hasta completar ${REPS_PER_SET} sentadillas</strong>. La aplicación promediará las repeticiones y mostrará el informe automáticamente.`;
}
