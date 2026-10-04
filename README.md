# Análisis de Valgo Dinámico en Sentadilla Bipodal (DKV Screening Tool)

Herramienta bioinstrumental estática de visión por computadora para el tamizaje, cuantificación y estratificación de riesgo lesional del Valgo Dinámico de Rodilla (*Dynamic Knee Valgus*, DKV) en sentadilla bipodal.

- **Asignatura:** Análisis Bioinstrumental del Movimiento Humano
- **Institución:** Departamento de Kinesiología, Facultad de Medicina, Universidad de Chile.

---

## 1. Fundamento Biomecánico & Variables Cuantitativas

El valgo dinámico de rodilla es un patrón de movimiento multiaxial en el plano frontal y transverso caracterizado por aducción y rotación interna femoral con abducción tibial y pronación de retropié. Es un biomarcador cinemático crítico asociado a lesiones del Ligamento Cruzado Anterior (LCA) y Síndrome de Dolor Femoropatelar (SDFP).

### Variables Analizadas:
1. **FPPA (Frontal Plane Projection Angle):** Desviación angular en el plano frontal entre la línea cadera-rodilla y rodilla-tobillo:
   $$\text{FPPA} = \vert{}180^\circ - \theta\vert{}$$
   - **< 5°:** Alineación Fisiológica Normal (Bajo riesgo).
   - **5° – 12°:** Valgo Dinámico Moderado.
   - **> 12°:** Colapso Medial Severo (Alto riesgo lesional).
2. **Knee-to-Ankle Ratio ($K/A$):** Ratio porcentual entre la distancia inter-rodilla y la distancia inter-tobillo:
   $$K/A = \left(\frac{\text{Distancia Inter-Rodilla}}{\text{Distancia Inter-Tobillo}}\right) \times 100$$
3. **Discriminación Anatómica Valgo vs. Varo:** Comparación euclidiana continua de la rodilla respecto a la línea media del centro pélvico para blindar la detección ante el efecto espejo de cámaras frontales.

---

## 2. Pipeline de Procesamiento de Señal
- **Adquisición:** MediaPipe Pose vía WebRTC (`getUserMedia`) con modelo de inferencia espacial de alta fidelidad (`modelComplexity: 2`).
- **Filtrado Temporal:** Filtro Paso Bajo Exponencial (EMA, $\alpha = 0.35$) aplicado sobre el ángulo articular para remover el jitter de alta frecuencia.
- **Segmentación Temporal:** Máquina de estados (`IDLE` $\rightarrow$ `COUNTDOWN` $\rightarrow$ `WAIT_DESCENT` $\rightarrow$ `RECORDING` $\rightarrow$ `FINISHED`) que identifica automáticamente el nadir y congela los valores máximos.
- **Feedback Multimodal:** Renderizado esqueletal en `<canvas>`, gráfica en tiempo real con Chart.js y síntesis de voz (`SpeechSynthesis`) con recomendaciones kinesiológicas automáticas.

---

## 3. Instrucciones de Ejecución
1. Acceder mediante cualquier navegador moderno con soporte WebRTC al enlace público:  
   👉 [https://chanillaomatias-dev.github.io/An-lisis-Valgo-Sentadilla/](https://chanillaomatias-dev.github.io/An-lisis-Valgo-Sentadilla/)
2. Presionar **Iniciar Cámara** y conceder permisos.
3. Ubicarse a 2.0 – 2.5 metros de distancia con vestimenta contrastante, asegurando que se visualicen pies, rodillas y caderas.
4. Presionar **🎯 Evaluar 1 Sentadilla** y realizar el gesto al finalizar la cuenta regresiva.
