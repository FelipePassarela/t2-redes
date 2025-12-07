class DashPlayer {
    constructor(videoElement) {
        this.video = videoElement;
        this.mediaSource = null;
        this.sourceBuffer = null;

        this.baseUrl = "http://localhost:8080/dash/";
        this.qualities = [];
        this.currentQualityIndex = 0;
        this.segmentDuration = 4.0;

        // --- NOVO: Variável para duração total ---
        this.totalDuration = 0;

        this.queue = [];
        this.isAppending = false;
        this.nextSegmentIndex = 1;
        this.isDownloading = false;
        this.initialized = false;
        this.isStopped = false;
        this.qualityChanged = false;

        this.lastDownloadSpeed = 0;
        this.minBufferTime = 10;

        this.videoSegments = [];
        this.totalDuration = 0;

        // Elementos da UI
        this.seekBar = document.getElementById('seekBar');
        this.timeDisplay = document.getElementById('timeDisplay');

        this.setupEventListeners();
        this.setupSeekControl(); // --- NOVO ---
    }

    log(msg, type = 'info') {
        const consoleEl = document.getElementById('logConsole');
        if (!consoleEl) { console.log(`[${type}] ${msg}`); return; }
        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        consoleEl.prepend(entry);
    }

    setupEventListeners() {
        this.mediaSource = new MediaSource();
        this.video.src = URL.createObjectURL(this.mediaSource);

        this.mediaSource.addEventListener('sourceopen', () => {
            this.log("MediaSource Aberto.");
        });

        // Loop principal
        setInterval(() => this.bufferLoop(), 1000);

        // Atualiza a barra visualmente
        this.video.addEventListener('timeupdate', () => this.updateStats());
    }

    // --- NOVO: Configura o evento de arraste da barra ---
    setupSeekControl() {
        if (!this.seekBar) return;

        // O evento 'input' ocorre enquanto arrasta, 'change' ao soltar.
        // Usamos 'change' para evitar spam de requisições.
        this.seekBar.addEventListener('change', (e) => {
            const targetTime = parseFloat(e.target.value);
            this.seek(targetTime);
        });

        // Opcional: Pausar enquanto arrasta (usando evento 'input')
        this.seekBar.addEventListener('input', () => {
            // Apenas visual, não dispara logica pesada
            const val = this.seekBar.value;
            this.updateTimeDisplay(val, this.totalDuration);
        });
    }

    // --- NOVO: Lógica Core do Seek ---
    getSegmentForTime(time) {
        // Procura no array um segmento onde: start <= time < end
        const seg = this.videoSegments.find(s => time >= s.start && time < s.end);

        // Se passar do final, retorna o último
        if (!seg && this.videoSegments.length > 0) {
            return this.videoSegments[this.videoSegments.length - 1];
        }
        return seg;
    }

    seek(time) {
        if (time < 0) time = 0;
        if (time >= this.totalDuration) time = this.totalDuration - 0.1;

        this.video.currentTime = time;

        // Usa o novo mapa para achar o índice correto
        const targetSeg = this.getSegmentForTime(time);

        if (targetSeg) {
            this.log(`Seek ${time.toFixed(2)}s -> Segmento ${targetSeg.index} (Início: ${targetSeg.start.toFixed(2)}s)`);
            this.nextSegmentIndex = targetSeg.index;
        } else {
            // Fallback (caso o mapa falhe)
            this.nextSegmentIndex = 1;
        }

        // Limpeza padrão
        this.queue = [];
        this.isAppending = false;
        this.isStopped = false;
        if (this.sourceBuffer && this.sourceBuffer.updating) {
            try { this.sourceBuffer.abort(); } catch (e) { }
        }
        this.isDownloading = false;
        this.bufferLoop();
    }

    async loadManifest() {
        if (this.isStopped) return;
        try {
            const response = await fetch(this.baseUrl + "manifest.mpd");
            if (!response.ok) throw new Error("Erro HTTP manifesto");
            const text = await response.text();

            if (this.parseManifest(text)) {
                await this.initializeSourceBuffer();
                await this.downloadInitSegment();

                // --- NOVO: Tenta iniciar reprodução automática ---
                try { await this.video.play(); } catch (e) { console.log("Autoplay bloqueado"); }
            }
        } catch (e) {
            this.log(e.message, 'error');
        }
    }

    parseManifest(xmlString) {
        const parser = new DOMParser();
        const xml = parser.parseFromString(xmlString, "text/xml");

        // 1. Duração Total (PT29.6S)
        const mpd = xml.querySelector("MPD");
        const durationAttr = mpd ? mpd.getAttribute("mediaPresentationDuration") : null;
        if (durationAttr) {
            this.totalDuration = this.parseISODuration(durationAttr);
            this.log(`Duração Total: ${this.totalDuration}s`);

            // Seta duração no MediaSource para a barra ficar correta
            if (this.mediaSource.readyState === 'open') {
                this.mediaSource.duration = this.totalDuration;
            }
        }

        // 2. Encontrar AdapationSet de Vídeo
        const adaptationSets = xml.querySelectorAll("AdaptationSet");
        let videoSet = null;
        for (const as of adaptationSets) {
            // Verifica se é video pelo contentType ou mimeType
            if (as.getAttribute("contentType") === "video" ||
                (as.getAttribute("mimeType") && as.getAttribute("mimeType").includes("video"))) {
                videoSet = as;
                break;
            }
        }

        if (!videoSet) {
            this.log("Nenhum vídeo encontrado.", "error");
            return false;
        }

        // 3. Processar SegmentTimeline (O PULO DO GATO)
        // Pega o template da primeira representação (assumindo alinhamento)
        const rep = videoSet.querySelector("Representation");
        const segmentTemplate = rep.querySelector("SegmentTemplate");

        if (segmentTemplate) {
            const timescale = parseFloat(segmentTemplate.getAttribute("timescale"));
            const timeline = segmentTemplate.querySelector("SegmentTimeline");

            this.videoSegments = [];
            let currentTime = 0;
            let segmentIndex = parseInt(segmentTemplate.getAttribute("startNumber") || 1);

            // Itera sobre cada tag <S> (Segmento)
            const sTags = timeline.querySelectorAll("S");
            sTags.forEach((s) => {
                const d = parseFloat(s.getAttribute("d")); // Duração em unidades de tempo
                const r = parseInt(s.getAttribute("r") || 0); // Repetições (se houver)

                // Calcula duração em segundos
                const durationSec = d / timescale;

                // Adiciona o segmento atual
                // Loop para tratar o atributo 'r' (repeat), comum em manifestos
                for (let i = 0; i <= r; i++) {
                    this.videoSegments.push({
                        index: segmentIndex,
                        start: currentTime,
                        end: currentTime + durationSec,
                        duration: durationSec
                    });
                    currentTime += durationSec;
                    segmentIndex++;
                }
            });

            this.log(`Mapa de segmentos criado: ${this.videoSegments.length} pedaços.`);
        }

        // 4. Parse das Qualidades (Mantém lógica anterior)
        const representations = videoSet.querySelectorAll("Representation");
        this.qualities = Array.from(representations).map((rep) => ({
            id: rep.getAttribute("id"),
            bandwidth: parseInt(rep.getAttribute("bandwidth")),
            height: rep.getAttribute("height"),
            codecs: rep.getAttribute("codecs") || "avc1.64001f",
            mimeType: "video/mp4"
        })).sort((a, b) => a.bandwidth - b.bandwidth);

        // Atualiza barra HTML se existir
        const seekBar = document.getElementById('seekBar');
        if (seekBar) seekBar.max = this.totalDuration;

        return true;
    }

    // --- NOVO: Helper para duração ISO 8601 (PT1H2M3.4S) ---
    parseISODuration(pt) {
        // Regex simplificado para pegar Horas, Minutos, Segundos
        const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
        const matches = pt.match(regex);
        if (!matches) return 0;

        const h = parseFloat(matches[1] || 0);
        const m = parseFloat(matches[2] || 0);
        const s = parseFloat(matches[3] || 0);

        return (h * 3600) + (m * 60) + s;
    }

    // --- Demais métodos (initializeSourceBuffer, etc) mantidos iguais ---
    // Apenas certifique-se de que downloadNextChunk usa a variável atualizada

    async initializeSourceBuffer() {
        if (this.sourceBuffer) return;
        const q = this.qualities[0];
        const mime = `${q.mimeType}; codecs="${q.codecs}"`;
        if (MediaSource.isTypeSupported(mime)) {
            this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
            this.sourceBuffer.addEventListener('updateend', () => {
                this.isAppending = false;
                this.processQueue();
            });
        }
    }

    processQueue() {
        if (this.queue.length > 0 && !this.sourceBuffer.updating) {
            this.isAppending = true;
            const data = this.queue.shift();
            try { this.sourceBuffer.appendBuffer(data); }
            catch (e) { this.isStopped = true; }
        }
    }

    addToBuffer(data) {
        if (this.isStopped && !this.sourceBuffer.updating) return; // Segurança
        this.queue.push(data);
        if (!this.isAppending && this.sourceBuffer && !this.sourceBuffer.updating) {
            this.processQueue();
        }
    }

    async downloadInitSegment() {
        // Mantido igual ao seu
        this.queue = [];
        const q = this.qualities[this.currentQualityIndex];
        const url = `${this.baseUrl}video/${q.id}/init.mp4`;
        try {
            const data = await this.fetchSegment(url);
            this.addToBuffer(data);
            this.initialized = true;
        } catch (e) { this.log("Erro init", "error"); }
    }

    async fetchSegment(url) {
        const t0 = performance.now();
        const res = await fetch(url);
        if (res.status === 404) throw new Error("EOS");
        if (!res.ok) throw new Error(res.status);
        const buf = await res.arrayBuffer();
        const sec = (performance.now() - t0) / 1000;
        this.lastDownloadSpeed = (buf.byteLength * 8) / sec;
        return buf;
    }

    async bufferLoop() {
        if (!this.initialized || this.isDownloading || this.isStopped) return;

        // Se buffer estiver muito cheio, pausa download (economia de banda)
        const bufferEnd = this.getBufferEnd();
        const ahead = bufferEnd - this.video.currentTime;

        if (ahead < this.minBufferTime) {
            this.checkQoS();
            this.isDownloading = true;
            await this.downloadNextChunk();
            this.isDownloading = false;
        }
    }

    checkQoS() {
        // Lógica mantida igual
        const available = this.lastDownloadSpeed * 0.7;
        let bestIdx = 0;
        for (let i = 0; i < this.qualities.length; i++) {
            if (available >= this.qualities[i].bandwidth) bestIdx = i;
        }
        if (bestIdx !== this.currentQualityIndex) {
            this.currentQualityIndex = bestIdx;
            this.qualityChanged = true;
        }
    }

    async downloadNextChunk() {
        // 1. Verifica fim da lista
        // Se o índice atual for maior que o último índice mapeado, fim do vídeo.
        if (this.videoSegments.length > 0) {
            const lastSeg = this.videoSegments[this.videoSegments.length - 1];
            if (this.nextSegmentIndex > lastSeg.index) {
                this.log("Fim da lista de segmentos.", "success");
                if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
                this.isStopped = true;
                return;
            }
        }

        if (this.qualityChanged) {
            await this.downloadInitSegment();
            this.qualityChanged = false;
        }

        const q = this.qualities[this.currentQualityIndex];
        const url = `${this.baseUrl}video/${q.id}/${this.nextSegmentIndex}.m4s`;

        try {
            // Verifica se não estamos pedindo segmento além da duração
            const maxSegments = Math.ceil(this.totalDuration / this.segmentDuration);
            if (this.nextSegmentIndex > maxSegments && this.totalDuration > 0) {
                throw new Error("EOS");
            }

            this.log(`Baixando Chunk ${this.nextSegmentIndex}`);
            const data = await this.fetchSegment(url);
            this.addToBuffer(data);
            this.nextSegmentIndex++;
        } catch (e) {
            if (e.message === "EOS") {
                this.log("Fim do vídeo");
                if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
                this.isStopped = true;
            } else {
                this.log("Erro chunk: " + e.message, 'warn');
            }
        }
    }

    getBufferEnd() {
        const b = this.video.buffered;
        const t = this.video.currentTime;
        for (let i = 0; i < b.length; i++) {
            if (t >= b.start(i) && t <= b.end(i)) return b.end(i);
        }
        return 0;
    }

    // --- NOVO: Formatador de tempo para UI (00:00) ---
    formatTime(seconds) {
        if (isNaN(seconds)) return "00:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    updateTimeDisplay(current, total) {
        if (this.timeDisplay) {
            this.timeDisplay.innerText = `${this.formatTime(current)} / ${this.formatTime(total)}`;
        }
    }

    updateStats() {
        if (!this.qualities.length) return;

        // Atualiza dados de texto
        const q = this.qualities[this.currentQualityIndex];
        document.getElementById('currentQuality').innerText = `Qualidade: ${q.height}p`;
        document.getElementById('bandwidth').innerText = `Banda: ${(this.lastDownloadSpeed / 1000000).toFixed(2)} Mbps`;

        const current = this.video.currentTime;
        const bufferEnd = this.getBufferEnd();

        document.getElementById('bufferLevel').innerText = `Buffer: ${(bufferEnd - current).toFixed(1)}s`;

        // --- NOVO: Atualiza a posição da barra se o usuário não estiver arrastando ---
        // (Nota: para perfeição, verificaríamos se o mouse está clicado, mas simples funciona assim)
        if (this.seekBar && Math.abs(this.seekBar.value - current) > 1.0) {
            this.seekBar.value = current;
        }
        this.updateTimeDisplay(current, this.totalDuration);
    }
}

// Init
const player = new DashPlayer(document.getElementById('videoPlayer'));
document.getElementById('btnLoad').addEventListener('click', () => player.loadManifest());
