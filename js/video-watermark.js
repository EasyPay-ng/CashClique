/*
 * Render a downloaded video through a canvas so the saved copy carries the
 * CashClique mark. This runs only when the browser supports MediaRecorder and
 * canvas capture; callers can fall back to the original file when it does not.
 */

function supportedMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ];
  return types.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function extensionForMime(mime) {
  return String(mime || '').toLowerCase().includes('mp4') ? 'mp4' : 'webm';
}

function loadWatermarkImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const image = new Image();
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish(null), 6000);
    image.crossOrigin = 'anonymous';
    image.onload = () => finish(removeWhiteBackground(image));
    image.onerror = () => finish(null);
    image.src = url + (url.includes('?') ? '&' : '?') + 'watermark=' + Date.now();
  });
}

// The logo asset is a JPG with a white square behind the mark. Convert the
// white pixels to transparency before it is painted over the video.
function removeWhiteBackground(image) {
  try {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const canvas = document.createElement('canvas');
    if (!width || !height) return null;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    let visiblePixels = 0;
    for (let i = 0; i < pixels.data.length; i += 4) {
      const whiteness = Math.min(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]);
      let alpha;
      if (whiteness <= 200) alpha = 255;
      else if (whiteness >= 252) alpha = 0;
      else alpha = Math.round(((252 - whiteness) / 52) * 255);
      pixels.data[i + 3] = Math.min(pixels.data[i + 3], alpha);
      if (pixels.data[i + 3] > 0) visiblePixels++;
    }
    if (!visiblePixels) return null;
    context.putImageData(pixels, 0, 0);
    return canvas;
  } catch (error) {
    // A logo without CORS headers cannot safely be painted into a video canvas.
    return null;
  }
}

function paintWatermark(context, width, height, logo, appName) {
  const padding = Math.max(12, Math.round(width * 0.03));
  const markWidth = Math.min(width * 0.18, 220);

  context.save();
  context.globalAlpha = 0.86;
  context.shadowColor = 'rgba(0, 0, 0, 0.55)';
  context.shadowBlur = Math.max(4, Math.round(width * 0.012));
  if (logo && logo.width > 0) {
    const markHeight = markWidth * (logo.height / logo.width);
    context.drawImage(logo, width - markWidth - padding, height - markHeight - padding, markWidth, markHeight);
  } else {
    context.fillStyle = 'rgba(255, 255, 255, 0.92)';
    context.font = `700 ${Math.max(16, Math.round(width * 0.035))}px Arial, sans-serif`;
    const label = appName || 'CashClique';
    context.fillText(label, width - context.measureText(label).width - padding, height - padding);
  }
  context.restore();
}

function cancelledError() {
  const error = new Error('Watermarked video save cancelled');
  error.cancelled = true;
  return error;
}

export async function renderWatermarkedVideo(videoBlob, options = {}) {
  const {
    logoUrl,
    appName = 'CashClique',
    isCancelled = () => false,
    onProgress = () => {}
  } = options;

  const mimeType = supportedMimeType();
  if (!mimeType || !HTMLCanvasElement.prototype.captureStream) {
    throw new Error('Watermarked video export is not supported in this browser');
  }
  if (isCancelled()) throw cancelledError();

  const sourceUrl = URL.createObjectURL(videoBlob);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.muted = true;
  video.src = sourceUrl;

  let audioContext = null;
  let animationFrame = 0;
  let recorder = null;
  let sourceStream = null;
  let outputStream = null;
  let cancelled = false;

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Could not read the video'));
      video.load();
    });

    if (isCancelled()) throw cancelledError();
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    const logo = await loadWatermarkImage(logoUrl);
    if (isCancelled()) throw cancelledError();

    outputStream = canvas.captureStream(30);
    sourceStream = video.captureStream ? video.captureStream() : null;

    // Prefer an AudioContext destination so the element can remain muted while
    // it plays automatically, without losing the source video's soundtrack.
    let audioTracksAdded = false;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioContext = new AudioContextClass();
        const source = audioContext.createMediaElementSource(video);
        const destination = audioContext.createMediaStreamDestination();
        source.connect(destination);
        await audioContext.resume();
        destination.stream.getAudioTracks().forEach(track => outputStream.addTrack(track));
        audioTracksAdded = destination.stream.getAudioTracks().length > 0;
      }
    } catch (error) {
      // Some browsers disallow MediaElementSource after an async gesture.
      // The native capture stream below is still able to carry audio there.
      audioTracksAdded = false;
    }
    if (!audioTracksAdded && sourceStream) {
      sourceStream.getAudioTracks().forEach(track => outputStream.addTrack(track));
    }

    const chunks = [];
    recorder = new MediaRecorder(outputStream, { mimeType });
    const recording = new Promise((resolve, reject) => {
      let settled = false;
      const stopRecording = () => {
        if (settled) return;
        if (recorder && recorder.state !== 'inactive') recorder.stop();
      };
      const finishWithError = (error) => {
        if (settled) return;
        settled = true;
        cancelAnimationFrame(animationFrame);
        video.pause();
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        reject(error);
      };

      recorder.ondataavailable = event => {
        if (event.data && event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => finishWithError(new Error('Video recording failed'));
      recorder.onstop = () => {
        if (settled) return;
        settled = true;
        cancelAnimationFrame(animationFrame);
        if (cancelled || isCancelled()) {
          reject(cancelledError());
          return;
        }
        resolve(new Blob(chunks, { type: recorder.mimeType || mimeType }));
      };
      video.onended = stopRecording;

      const drawFrame = () => {
        if (settled) return;
        if (isCancelled()) {
          cancelled = true;
          finishWithError(cancelledError());
          return;
        }
        context.drawImage(video, 0, 0, width, height);
        paintWatermark(context, width, height, logo, appName);
        if (duration > 0) onProgress(video.currentTime, duration);
        animationFrame = requestAnimationFrame(drawFrame);
      };

      recorder.start(1000);
      drawFrame();
      video.play().catch(error => finishWithError(error));
    });

    if (!recording || !recording.size) throw new Error('Watermarked video was empty');
    return { blob: recording, extension: extensionForMime(mimeType) };
  } finally {
    cancelAnimationFrame(animationFrame);
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (audioContext) {
      try { await audioContext.close(); } catch (error) {}
    }
    if (sourceStream) sourceStream.getTracks().forEach(track => track.stop());
    if (outputStream) outputStream.getTracks().forEach(track => track.stop());
    URL.revokeObjectURL(sourceUrl);
  }
}
