import { parseISODuration, log } from './utils.js';

export function parseManifest(xmlString) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlString, "text/xml");

    const result = {
        totalDuration: 0,
        videoSegments: [],
        qualities: [],
        success: false
    };

    const mpd = xml.querySelector("MPD");
    const durationAttr = mpd ? mpd.getAttribute("mediaPresentationDuration") : null;
    if (durationAttr) {
        result.totalDuration = parseISODuration(durationAttr);
        log(`Duração Total: ${result.totalDuration}s`);
    }

    const adaptationSets = xml.querySelectorAll("AdaptationSet");
    let videoSet = null;
    for (const as of adaptationSets) {
        if (as.getAttribute("contentType") === "video" ||
            (as.getAttribute("mimeType") && as.getAttribute("mimeType").includes("video"))) {
            videoSet = as;
            break;
        }
    }

    if (!videoSet) {
        log("Nenhum vídeo encontrado.", "error");
        return result;
    }

    const rep = videoSet.querySelector("Representation");
    const segmentTemplate = rep.querySelector("SegmentTemplate");

    if (segmentTemplate) {
        const timescale = parseFloat(segmentTemplate.getAttribute("timescale"));
        const timeline = segmentTemplate.querySelector("SegmentTimeline");

        let currentTime = 0;
        let segmentIndex = parseInt(segmentTemplate.getAttribute("startNumber") || 1);

        const sTags = timeline.querySelectorAll("S");
        sTags.forEach((s) => {
            const d = parseFloat(s.getAttribute("d")); // Duração em unidades de tempo
            const r = parseInt(s.getAttribute("r") || 0);

            // Calcula duração em segundos
            const durationSec = d / timescale;

            // Adiciona o segmento atual
            // Loop para tratar o atributo 'r' (repeat), comum em manifestos
            for (let i = 0; i <= r; i++) {
                result.videoSegments.push({
                    index: segmentIndex,
                    start: currentTime,
                    end: currentTime + durationSec,
                    duration: durationSec
                });
                currentTime += durationSec;
                segmentIndex++;
            }
        });
    }

    const representations = videoSet.querySelectorAll("Representation");
    result.qualities = Array.from(representations).map((rep) => ({
        id: rep.getAttribute("id"),
        bandwidth: parseInt(rep.getAttribute("bandwidth")),
        height: rep.getAttribute("height"),
        codecs: rep.getAttribute("codecs") || "avc1.64001f",
        mimeType: "video/mp4"
    })).sort((a, b) => a.bandwidth - b.bandwidth);

    result.success = true;
    return result;
}
