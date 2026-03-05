import Meyda from 'meyda';
import MidiWriter from 'midi-writer-js';
import { getTone } from './lib/tone-setup';

export function zappafiedApp() {
  return {
    audioSrc: null,
    audioContext: null,
    offlineContext: null,
    source: null,
    features: [],
    midiData: [],
    isProcessing: false,
    isRendering: false,
    isReady: false,
    isAnalyzed: false,
    noiseThreshold: 0.02,
    quantizeLevel: "16",
    pitchSmoothing: 50,
    midiInstrument: "1",
    decodedAudioBuffer: null,
    renderedSrc: null,

    async handleFileUpload(event) {
      const file = event.target.files[0];
      if (!file || !file.type.startsWith('audio/')) {
        alert('Please upload a valid audio file.');
        return;
      }

      this.resetData();
      this.audioSrc = URL.createObjectURL(file);
      this.isReady = true;

      try {
        await getTone();
      } catch (error) {
        console.error('Error loading Tone.js:', error);
      }
    },

    resetData() {
      this.features = [];
      this.midiData = [];
      this.isAnalyzed = false;
      this.decodedAudioBuffer = null;

      if (this.renderedSrc) {
        URL.revokeObjectURL(this.renderedSrc);
        this.renderedSrc = null;
      }
      if (this.audioContext) {
        this.audioContext.close();
        this.audioContext = null;
      }
      if (this.offlineContext) {
        this.offlineContext = null;
      }
      const canvas = document.getElementById('visualizationCanvas');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    },

    async startAnalysis() {
      if (this.isProcessing) return;

      try {
        this.isProcessing = true;

        // Reset data but keep settings
        this.features = [];
        this.midiData = [];
        this.decodedAudioBuffer = null;
        if (this.renderedSrc) {
          URL.revokeObjectURL(this.renderedSrc);
          this.renderedSrc = null;
        }
        if (this.audioContext) {
          await this.audioContext.close();
          this.audioContext = null;
        }
        if (this.offlineContext) {
          this.offlineContext = null;
        }

        // Clear canvas
        const canvas = document.getElementById('visualizationCanvas');
        if (canvas) {
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }

        // Fetch audio data
        console.log('Fetching audio data...');
        const response = await fetch(this.audioSrc);
        if (!response.ok) {
          throw new Error(`Failed to fetch audio: ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
          throw new Error('Empty audio buffer received');
        }

        // Decode audio
        console.log('Decoding audio data...');
        const tempContext = new AudioContext();
        const audioBuffer = await tempContext.decodeAudioData(arrayBuffer);
        await tempContext.close();

        // Store for later mixing
        this.decodedAudioBuffer = audioBuffer;

        // Process the audio in chunks
        console.log('Processing audio...');
        const bufferSize = 2048;
        const sampleRate = audioBuffer.sampleRate;
        const totalSamples = audioBuffer.length;
        const channelData = new Float32Array(audioBuffer.length);
        audioBuffer.copyFromChannel(channelData, 0);

        let features = [];
        for (let startSample = 0; startSample < totalSamples; startSample += bufferSize) {
          const endSample = Math.min(startSample + bufferSize, totalSamples);
          const chunkSize = Math.pow(2, Math.floor(Math.log2(endSample - startSample)));
          if (chunkSize < 64) continue;

          const chunk = channelData.slice(startSample, startSample + chunkSize);
          if (chunk.length === 0) continue;

          try {
            const featureData = Meyda.extract(
              ["amplitudeSpectrum", "rms"],
              chunk,
              sampleRate
            );

            if (featureData && featureData.rms > this.noiseThreshold) {
              const frequency = this.calculatePitch(featureData.amplitudeSpectrum, sampleRate);
              if (frequency > 0) {
                const time = startSample / sampleRate;
                features.push({
                  pitch: frequency,
                  time: time,
                  rms: featureData.rms
                });
              }
            }
          } catch (featureError) {
            console.warn('Error processing chunk at', startSample, featureError);
            continue;
          }
        }

        console.log(`Analysis complete. Found ${features.length} features`);

        if (features.length > 0) {
          const pitches = features.map(f => f.pitch);
          const smoothedPitches = this.smoothPitch(pitches);
          features = features.map((f, i) => ({
            ...f,
            pitch: smoothedPitches[i]
          }));

          features = features.map(f => ({
            ...f,
            time: this.quantizeTime(f.time)
          }));

          features = features.filter((f, i, arr) => {
            if (i === 0) return true;
            const prev = arr[i - 1];
            return !(Math.abs(f.time - prev.time) < 0.01 &&
                    Math.abs(f.pitch - prev.pitch) < 10);
          });
        }

        this.features = features.sort((a, b) => a.time - b.time);

        this.features.forEach(feature => {
          this.generateMIDI(feature.pitch, feature.time, feature.rms);
        });

        console.log(`Generated ${this.midiData.length} MIDI notes`);

        this.drawVisualization();
        this.isAnalyzed = true;

        // Render MIDI + original audio into a single mixed track
        await this.renderMixedAudio();

      } catch (error) {
        console.error('Error analyzing audio:', error);
        alert(`Analysis failed: ${error.message}`);
      } finally {
        this.isProcessing = false;
      }
    },

    async renderMixedAudio() {
      if (!this.decodedAudioBuffer || !this.midiData.length) {
        // Nothing to mix — just play original
        const audioPlayer = document.getElementById('audioPlayer');
        audioPlayer.src = this.audioSrc;
        return;
      }

      this.isRendering = true;
      try {
        const Tone = await getTone();
        const duration = this.decodedAudioBuffer.duration;
        const sampleRate = this.decodedAudioBuffer.sampleRate;
        const midiData = this.midiData;
        const instrument = parseInt(this.midiInstrument);

        console.log('Rendering MIDI synth offline...');

        // Render the MIDI synth to an AudioBuffer using Tone.Offline
        const synthToneBuffer = await Tone.Offline(({ transport }) => {
          let synth;
          if (instrument >= 9 && instrument <= 16) {
            synth = new Tone.PolySynth(Tone.MetalSynth).toDestination();
          } else {
            synth = new Tone.PolySynth(Tone.Synth, {
              envelope: { attack: 0.005, decay: 0.1, sustain: 0.3, release: 0.1 }
            }).toDestination();
          }

          midiData.forEach(event => {
            transport.schedule((time) => {
              synth.triggerAttackRelease(
                Tone.Frequency(event.note, "midi").toFrequency(),
                "8n",
                time,
                event.velocity ? event.velocity / 127 : 0.7
              );
            }, event.time);
          });

          transport.start();
        }, duration + 1, 2, sampleRate);

        const synthAudioBuffer = synthToneBuffer.get();
        console.log('MIDI render complete. Mixing with original audio...');

        // Mix original + synth in an OfflineAudioContext
        const numChannels = this.decodedAudioBuffer.numberOfChannels;
        const totalLength = this.decodedAudioBuffer.length;
        const mixCtx = new OfflineAudioContext(numChannels, totalLength, sampleRate);

        const origSource = mixCtx.createBufferSource();
        origSource.buffer = this.decodedAudioBuffer;
        origSource.connect(mixCtx.destination);
        origSource.start(0);

        // Resample synth buffer if needed, otherwise connect directly
        const synthSource = mixCtx.createBufferSource();
        // Build a buffer that matches the original's channel count and length
        const synthMono = mixCtx.createBuffer(numChannels, totalLength, sampleRate);
        for (let ch = 0; ch < numChannels; ch++) {
          const synthCh = ch < synthAudioBuffer.numberOfChannels
            ? synthAudioBuffer.getChannelData(ch)
            : synthAudioBuffer.getChannelData(0);
          const dest = synthMono.getChannelData(ch);
          const copyLen = Math.min(synthCh.length, dest.length);
          dest.set(synthCh.subarray(0, copyLen));
        }

        // Slight gain reduction on synth to blend with original
        const synthGain = mixCtx.createGain();
        synthGain.gain.value = 0.6;
        synthSource.buffer = synthMono;
        synthSource.connect(synthGain);
        synthGain.connect(mixCtx.destination);
        synthSource.start(0);

        const mixedBuffer = await mixCtx.startRendering();
        console.log('Mix complete. Encoding WAV...');

        const wavBuffer = this.encodeWAV(mixedBuffer);
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });

        if (this.renderedSrc) URL.revokeObjectURL(this.renderedSrc);
        this.renderedSrc = URL.createObjectURL(blob);

        const audioPlayer = document.getElementById('audioPlayer');
        audioPlayer.src = this.renderedSrc;
        console.log('Ready for playback.');

      } catch (error) {
        console.error('Error rendering mixed audio:', error);
        // Fallback to original audio
        const audioPlayer = document.getElementById('audioPlayer');
        audioPlayer.src = this.audioSrc;
      } finally {
        this.isRendering = false;
      }
    },

    encodeWAV(audioBuffer) {
      const numChannels = audioBuffer.numberOfChannels;
      const sampleRate = audioBuffer.sampleRate;
      const numSamples = audioBuffer.length;
      const bitDepth = 16;
      const bytesPerSample = bitDepth / 8;
      const blockAlign = numChannels * bytesPerSample;
      const byteRate = sampleRate * blockAlign;
      const dataSize = numSamples * numChannels * bytesPerSample;

      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);

      const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) {
          view.setUint8(offset + i, str.charCodeAt(i));
        }
      };

      writeString(0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, byteRate, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, bitDepth, true);
      writeString(36, 'data');
      view.setUint32(40, dataSize, true);

      // Interleave channels and write as 16-bit PCM
      let offset = 44;
      for (let i = 0; i < numSamples; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
          const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
          view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
          offset += 2;
        }
      }

      return buffer;
    },

    calculatePitch(spectrum, sampleRate) {
      try {
        if (!spectrum || spectrum.length === 0) return 0;

        const binSize = sampleRate / (spectrum.length * 2);
        let maxIndex = 0;
        let maxValue = 0;

        for (let i = 0; i < spectrum.length; i++) {
          if (spectrum[i] > maxValue) {
            maxValue = spectrum[i];
            maxIndex = i;
          }
        }

        const frequency = maxIndex * binSize;
        return (frequency >= 80 && frequency <= 1000) ? frequency : 0;
      } catch (error) {
        console.warn('Error calculating pitch:', error);
        return 0;
      }
    },

    generateMIDI(pitch, time, velocity) {
      const midiNote = Math.round(69 + 12 * Math.log2(pitch / 440));

      if (midiNote >= 21 && midiNote <= 108) {
        const lastNote = this.midiData[this.midiData.length - 1];
        if (!lastNote ||
            lastNote.note !== midiNote ||
            time - lastNote.time > 0.1) {

          this.midiData.push({
            note: midiNote,
            time: time,
            velocity: Math.min(127, Math.floor(velocity * 127))
          });
        }
      }
    },

    drawVisualization() {
      const canvas = document.getElementById('visualizationCanvas');
      if (!canvas || !this.features.length) {
        console.log('No canvas or features to draw');
        return;
      }

      const minWidth = 600;
      const minHeight = 400;

      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = Math.max(rect.width || minWidth, minWidth);
      canvas.height = Math.max(rect.height || minHeight, minHeight);

      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;

      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, width, height);

      const duration = this.features[this.features.length - 1].time;
      const pitchValues = this.features.map(f => f.pitch);
      const minPitch = Math.min(...pitchValues);
      const maxPitch = Math.max(...pitchValues);
      const pitchRange = maxPitch - minPitch || 1;

      const margin = { left: 60, right: 20, top: 20, bottom: 40 };
      const plotWidth = width - margin.left - margin.right;
      const plotHeight = height - margin.top - margin.bottom;

      ctx.strokeStyle = '#eee';
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= 10; i++) {
        const x = margin.left + (plotWidth * i / 10);
        ctx.beginPath();
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, height - margin.bottom);
        ctx.stroke();
      }
      for (let i = 0; i <= 10; i++) {
        const y = margin.top + (plotHeight * i / 10);
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(width - margin.right, y);
        ctx.stroke();
      }

      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(margin.left, margin.top);
      ctx.lineTo(margin.left, height - margin.bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(margin.left, height - margin.bottom);
      ctx.lineTo(width - margin.right, height - margin.bottom);
      ctx.stroke();

      this.features.forEach((feature, i) => {
        const x = margin.left + (plotWidth * feature.time / duration);
        const y = (height - margin.bottom) - (plotHeight * (feature.pitch - minPitch) / pitchRange);
        const radius = Math.max(3, feature.rms * 15);

        if (i > 0) {
          const prev = this.features[i - 1];
          const prevX = margin.left + (plotWidth * prev.time / duration);
          const prevY = (height - margin.bottom) - (plotHeight * (prev.pitch - minPitch) / pitchRange);
          ctx.beginPath();
          ctx.moveTo(prevX, prevY);
          ctx.lineTo(x, y);
          ctx.strokeStyle = 'rgba(0, 0, 255, 0.3)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fillStyle = `hsla(${(feature.pitch % 12) * 30}, 70%, 50%, 0.8)`;
        ctx.fill();
      });

      ctx.fillStyle = 'black';
      ctx.font = '12px Arial';
      for (let i = 0; i <= 5; i++) {
        const pitch = minPitch + (pitchRange * i / 5);
        const y = margin.top + plotHeight * (1 - i / 5);
        ctx.textAlign = 'right';
        ctx.fillText(Math.round(pitch) + 'Hz', margin.left - 5, y + 4);
      }
      for (let i = 0; i <= 5; i++) {
        const time = (duration * i / 5);
        const x = margin.left + plotWidth * (i / 5);
        ctx.textAlign = 'center';
        ctx.fillText(time.toFixed(2) + 's', x, height - margin.bottom + 20);
      }
    },

    exportMIDI() {
      if (this.midiData.length === 0) {
        alert('No MIDI data to export.');
        return;
      }

      getTone().then(Tone => {
        const track = new MidiWriter.Track();

        track.addEvent([
          new MidiWriter.ProgramChangeEvent({instrument: parseInt(this.midiInstrument)}),
          new MidiWriter.TrackNameEvent({text: 'Zappafied Voice'})
        ]);

        const ticksPerBeat = 128;
        const beatsPerSecond = 2;

        this.midiData.forEach((event) => {
          const startTick = Math.round(event.time * ticksPerBeat * beatsPerSecond);

          const note = new MidiWriter.NoteEvent({
            pitch: [Tone.Frequency(event.note, "midi").toNote()],
            duration: '8',
            startTick: startTick,
            velocity: event.velocity
          });

          track.addEvent(note);
        });

        const write = new MidiWriter.Writer([track]);
        const blob = new Blob([write.buildFile()], { type: 'audio/midi' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'zappafied.mid';
        a.click();
        URL.revokeObjectURL(url);
      }).catch(error => {
        console.error('Error exporting MIDI:', error);
        alert('An error occurred while exporting MIDI.');
      });
    },

    smoothPitch(pitches) {
      if (this.pitchSmoothing === 0) return pitches;

      const smoothingFactor = this.pitchSmoothing / 100;
      const smoothedPitches = [];
      let prevPitch = pitches[0];

      for (let i = 0; i < pitches.length; i++) {
        const currentPitch = pitches[i];
        const smoothedPitch = prevPitch + (currentPitch - prevPitch) * (1 - smoothingFactor);
        smoothedPitches.push(smoothedPitch);
        prevPitch = smoothedPitch;
      }

      return smoothedPitches;
    },

    quantizeTime(time) {
      if (this.quantizeLevel === "0") return time;

      const quarterNote = 60 / 120;
      const division = parseInt(this.quantizeLevel);
      const gridSize = (4 * quarterNote) / division;

      return Math.round(time / gridSize) * gridSize;
    }
  }
}
