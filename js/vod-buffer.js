export function initVodBuffer(video, assetUrl) {
    const CHUNK_SIZE = 1024 * 1024; // 1MB
    const mediaSource = new MediaSource();
    let sourceBuffer = null;
    let fileSize = 0;
    let bytesLoaded = 0;
    let isBuffering = false;

    video.src = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener('sourceopen', async () => {
        // Codec genérico para MP4 (H.264 + AAC)
        // Em produção, deve ser detectado ou configurado corretamente
        const mimeCodec = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';

        if (MediaSource.isTypeSupported(mimeCodec)) {
            sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);

            try {
                // Obter tamanho total
                const response = await fetch(assetUrl, { method: 'HEAD' });
                const lengthHeader = response.headers.get('content-length');
                if (lengthHeader) {
                    fileSize = parseInt(lengthHeader);
                    fetchNextChunk();
                } else {
                    console.error('Content-Length não disponível');
                }
            } catch (e) {
                console.error('Erro ao obter metadados do vídeo', e);
            }
        } else {
            console.error('Codec não suportado:', mimeCodec);
        }
    });

    async function fetchNextChunk() {
        if (bytesLoaded >= fileSize || isBuffering || (sourceBuffer && sourceBuffer.updating)) return;

        isBuffering = true;
        const start = bytesLoaded;
        const end = Math.min(start + CHUNK_SIZE - 1, fileSize - 1);

        console.log(`Baixando bytes ${start}-${end}`);

        try {
            const response = await fetch(assetUrl, {
                headers: { Range: `bytes=${start}-${end}` }
            });
            const buffer = await response.arrayBuffer();

            if (!sourceBuffer.updating) {
                sourceBuffer.appendBuffer(buffer);
                bytesLoaded += buffer.byteLength;
            } else {
                sourceBuffer.addEventListener('updateend', function onUpdate() {
                    sourceBuffer.removeEventListener('updateend', onUpdate);
                    sourceBuffer.appendBuffer(buffer);
                    bytesLoaded += buffer.byteLength;
                }, { once: true });
            }
        } catch (err) {
            console.error('Erro ao baixar chunk:', err);
        } finally {
            isBuffering = false;
        }
    }

    video.addEventListener('timeupdate', () => {
        if (sourceBuffer && !sourceBuffer.updating && bytesLoaded < fileSize) {
            const bufferEnd = sourceBuffer.buffered.length ? sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) : 0;
            // Se buffer à frente for menor que 10s, baixa mais
            if (bufferEnd - video.currentTime < 10) {
                fetchNextChunk();
            }
        }

        if (bytesLoaded >= fileSize && mediaSource.readyState === 'open' && !sourceBuffer.updating) {
            mediaSource.endOfStream();
        }
    });
}
