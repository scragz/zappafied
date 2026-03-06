import Meyda from 'meyda';
import MidiWriter from 'midi-writer-js';
import { getTone } from './lib/tone-setup';

export function zappafiedApp() {
  return {
    audioSrc: null,
    audioFile: null,
    audioArrayBuffer: null,
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
    noteSmoothing: 0,
    midiInstrument: "1",
    decodedAudioBuffer: null,
    renderedSrc: null,

    // Progress tracking
    analysisProgress: 0,
    analysisStage: '',
    renderProgress: 0,
    renderStage: '',
    _renderId: 0,

    async handleFileUpload(event) {
      const file = event.target.files[0];
      if (!file || !file.type.startsWith('audio/')) {
        alert('Please upload a valid audio file.');
        return;
      }

      this.resetData();
      this.audioFile = file;
      this.audioSrc = URL.createObjectURL(file);

      // Read the array buffer immediately while the file permission is still valid.
      // On Android, file references from the recorder can become unreadable after a delay.
      try {
        this.audioArrayBuffer = await file.arrayBuffer();
      } catch (error) {
        console.error('Error reading audio file:', error);
        alert('Analysis failed: ' + error.message);
        return;
      }

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
      this.audioFile = null;
      this.audioArrayBuffer = null;

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

      // Cancel any in-progress render — new analysis makes it stale
      this._renderId++;
      this.isRendering = false;
      this.isAnalyzed = false;

      try {
        this.isProcessing = true;
        this.analysisProgress = 0;
        this.analysisStage = 'Fetching audio...';

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
        this.offlineContext = null;

        // Clear canvas
        const canvas = document.getElementById('visualizationCanvas');
        if (canvas) {
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }

        // Use the eagerly-read buffer from handleFileUpload.
        // On Android, file references from the recorder become unreadable after a delay,
        // so we read the data immediately when the file is selected.
        this.analysisProgress = 10;
        this.analysisStage = 'Loading audio...';

        const arrayBuffer = this.audioArrayBuffer;
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
          throw new Error('Empty audio buffer received');
        }

        this.analysisProgress = 20;
        this.analysisStage = 'Decoding audio...';

        const tempContext = new AudioContext();
        // slice(0) creates a copy — decodeAudioData transfers (detaches) its argument,
        // which would leave audioArrayBuffer empty for any subsequent analysis run.
        const audioBuffer = await tempContext.decodeAudioData(arrayBuffer.slice(0));
        await tempContext.close();

        // Store for later mixing
        this.decodedAudioBuffer = audioBuffer;

        this.analysisProgress = 35;
        this.analysisStage = 'Extracting pitch features...';

        const bufferSize = 2048;
        // Overlapping frames: 512-sample hop ≈ 11.6 ms at 44100 Hz, giving 4× better
        // time resolution than non-overlapping 2048-sample blocks (~46 ms).
        const hopSize = 512;
        const sampleRate = audioBuffer.sampleRate;
        const totalSamples = audioBuffer.length;
        const channelData = new Float32Array(audioBuffer.length);
        audioBuffer.copyFromChannel(channelData, 0);

        let features = [];
        const totalHops = Math.ceil(totalSamples / hopSize);
        let hopIndex = 0;
        const yieldEvery = Math.max(1, Math.floor(totalHops / 20));

        // Spectral flux onset detection state
        let prevSpectrum = null;
        const fluxHistory = [];
        const FLUX_WINDOW = 10;
        const ONSET_FLUX_RATIO = 1.5; // flux must exceed 1.5× local average to count as onset

        for (let startSample = 0; startSample < totalSamples; startSample += hopSize) {
          const remaining = totalSamples - startSample;
          if (remaining < 64) break;
          // Use full bufferSize when available; power-of-2 fallback near EOF.
          const chunkSize = remaining >= bufferSize
            ? bufferSize
            : Math.pow(2, Math.floor(Math.log2(remaining)));
          if (chunkSize < 64) break;

          const chunk = channelData.slice(startSample, startSample + chunkSize);

          try {
            const featureData = Meyda.extract(
              ["amplitudeSpectrum", "rms"],
              chunk,
              sampleRate
            );

            if (featureData && featureData.amplitudeSpectrum) {
              const spectrum = featureData.amplitudeSpectrum;
              const rms = featureData.rms;

              // Half-wave rectified spectral flux: sum positive spectral differences.
              // This peaks sharply at note onsets, catching attacks before RMS rises.
              let flux = 0;
              if (prevSpectrum) {
                const len = Math.min(spectrum.length, prevSpectrum.length);
                for (let i = 0; i < len; i++) {
                  const diff = spectrum[i] - prevSpectrum[i];
                  if (diff > 0) flux += diff;
                }
              }
              fluxHistory.push(flux);
              if (fluxHistory.length > FLUX_WINDOW) fluxHistory.shift();

              // Local average of previous frames (exclude current)
              const prevFluxes = fluxHistory.slice(0, -1);
              const localAvg = prevFluxes.length > 0
                ? prevFluxes.reduce((a, b) => a + b, 0) / prevFluxes.length
                : 0;
              const isOnset = prevSpectrum !== null
                && rms > this.noiseThreshold
                && flux > localAvg * ONSET_FLUX_RATIO;

              if (rms > this.noiseThreshold) {
                const frequency = this.calculatePitch(spectrum, sampleRate);
                if (frequency > 0) {
                  features.push({
                    pitch: frequency,
                    time: startSample / sampleRate,
                    rms,
                    isOnset,
                  });
                }
              }

              // Save a copy — Meyda may reuse internal typed-array buffers.
              prevSpectrum = new Float32Array(spectrum);
            }
          } catch (featureError) {
            console.warn('Error processing chunk at', startSample, featureError);
          }

          hopIndex++;
          // Yield to browser periodically so the progress bar actually updates
          if (hopIndex % yieldEvery === 0) {
            this.analysisProgress = 35 + Math.round((hopIndex / totalHops) * 40);
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }

        this.analysisProgress = 75;
        this.analysisStage = 'Processing notes...';

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

        this.analysisProgress = 85;
        this.analysisStage = 'Generating MIDI...';

        this.features = features.sort((a, b) => a.time - b.time);
        const maxRms = Math.max(...this.features.map(f => f.rms), 1e-6);

        // Group consecutive voiced frames into discrete note events so that each
        // sung/played note produces exactly one MIDI event, timed at the onset
        // frame rather than scattered across the note's duration.
        const noteGroups = this._groupIntoNoteEvents(this.features);
        const smoothedGroups = this.smoothNotes(noteGroups);
        smoothedGroups.forEach(group => {
          // Median pitch across the group is more stable than any single frame.
          const sorted = group.map(f => f.pitch).sort((a, b) => a - b);
          const medianPitch = sorted[Math.floor(sorted.length / 2)];
          const peakRms = Math.max(...group.map(f => f.rms));
          this.generateMIDI(medianPitch, group[0].time, peakRms / maxRms);
        });

        console.log(`Generated ${this.midiData.length} MIDI notes`);

        this.analysisProgress = 95;
        this.drawVisualization();

        this.analysisProgress = 100;
        this.analysisStage = 'Analysis complete';

        // Analysis is done — decouple from rendering
        this.isProcessing = false;
        this.isAnalyzed = true;

        // Kick off render without blocking; it manages its own isRendering state
        this.renderMixedAudio();

      } catch (error) {
        console.error('Error analyzing audio:', error);
        alert(`Analysis failed: ${error.message}`);
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

      // Version stamp — lets us detect when a newer render has been requested
      const renderId = ++this._renderId;

      this.isRendering = true;
      this.renderProgress = 0;
      this.renderStage = 'Loading synth...';

      try {
        const Tone = await getTone();
        if (renderId !== this._renderId) return;

        this.renderProgress = 15;
        this.renderStage = 'Rendering MIDI synth...';

        const duration = this.decodedAudioBuffer.duration;
        const sampleRate = this.decodedAudioBuffer.sampleRate;
        const midiData = this.midiData;
        const instrument = parseInt(this.midiInstrument);

        const synthToneBuffer = await Tone.Offline(({ transport }) => {
          let synth;
          if (instrument >= 9 && instrument <= 16) {
            // Percussion / drums
            synth = new Tone.PolySynth(Tone.MetalSynth).toDestination();
          } else if (instrument === 1) {
            // Acoustic Piano — bright triangle, piano-like decay
            synth = new Tone.PolySynth(Tone.Synth, {
              oscillator: { type: 'triangle' },
              envelope: { attack: 0.005, decay: 0.8, sustain: 0.2, release: 1.0 }
            }).toDestination();
          } else if (instrument === 11) {
            // Vibraphone — sine with long bell-like ring
            synth = new Tone.PolySynth(Tone.Synth, {
              oscillator: { type: 'sine' },
              envelope: { attack: 0.001, decay: 1.5, sustain: 0.05, release: 1.2 }
            }).toDestination();
          } else if (instrument === 25) {
            // Acoustic Guitar — triangle with sharp pluck decay
            synth = new Tone.PolySynth(Tone.Synth, {
              oscillator: { type: 'triangle' },
              envelope: { attack: 0.001, decay: 0.35, sustain: 0.08, release: 0.4 }
            }).toDestination();
          } else if (instrument === 41) {
            // Violin — sawtooth with slow bowed attack, high sustain
            synth = new Tone.PolySynth(Tone.Synth, {
              oscillator: { type: 'sawtooth' },
              envelope: { attack: 0.12, decay: 0.1, sustain: 0.85, release: 0.6 }
            }).toDestination();
          } else if (instrument === 57) {
            // Trumpet — sawtooth, punchy attack, bright sustain
            synth = new Tone.PolySynth(Tone.Synth, {
              oscillator: { type: 'sawtooth' },
              envelope: { attack: 0.02, decay: 0.05, sustain: 0.9, release: 0.2 }
            }).toDestination();
          } else if (instrument === 74) {
            // Flute — sine, airy soft attack, smooth sustain
            synth = new Tone.PolySynth(Tone.Synth, {
              oscillator: { type: 'sine' },
              envelope: { attack: 0.08, decay: 0.05, sustain: 0.92, release: 0.4 }
            }).toDestination();
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

        if (renderId !== this._renderId) return;

        this.renderProgress = 60;
        this.renderStage = 'Mixing audio...';

        const synthAudioBuffer = synthToneBuffer.get();

        const numChannels = this.decodedAudioBuffer.numberOfChannels;
        const totalLength = this.decodedAudioBuffer.length;
        const mixCtx = new OfflineAudioContext(numChannels, totalLength, sampleRate);

        const origSource = mixCtx.createBufferSource();
        origSource.buffer = this.decodedAudioBuffer;
        origSource.connect(mixCtx.destination);
        origSource.start(0);

        const synthSource = mixCtx.createBufferSource();
        const synthMono = mixCtx.createBuffer(numChannels, totalLength, sampleRate);
        for (let ch = 0; ch < numChannels; ch++) {
          const synthCh = ch < synthAudioBuffer.numberOfChannels
            ? synthAudioBuffer.getChannelData(ch)
            : synthAudioBuffer.getChannelData(0);
          const dest = synthMono.getChannelData(ch);
          const copyLen = Math.min(synthCh.length, dest.length);
          dest.set(synthCh.subarray(0, copyLen));
        }

        const synthGain = mixCtx.createGain();
        synthGain.gain.value = 1.0;
        synthSource.buffer = synthMono;
        synthSource.connect(synthGain);
        synthGain.connect(mixCtx.destination);
        synthSource.start(0);

        const mixedBuffer = await mixCtx.startRendering();
        if (renderId !== this._renderId) return;

        this.renderProgress = 85;
        this.renderStage = 'Encoding WAV...';

        const wavBuffer = this.encodeWAV(mixedBuffer);
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });

        if (renderId !== this._renderId) return;

        if (this.renderedSrc) URL.revokeObjectURL(this.renderedSrc);
        this.renderedSrc = URL.createObjectURL(blob);

        const audioPlayer = document.getElementById('audioPlayer');
        audioPlayer.src = this.renderedSrc;

        this.renderProgress = 100;
        this.renderStage = 'Ready';

      } catch (error) {
        if (renderId === this._renderId) {
          console.error('Error rendering mixed audio:', error);
          const audioPlayer = document.getElementById('audioPlayer');
          audioPlayer.src = this.audioSrc;
        }
      } finally {
        if (renderId === this._renderId) {
          this.isRendering = false;
        }
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
        const minBin = Math.max(1, Math.floor(80 / binSize));
        const maxBin = Math.min(spectrum.length - 2, Math.ceil(1000 / binSize));

        // Harmonic Product Spectrum: multiply spectrum by downsampled copies to
        // reinforce the fundamental frequency over its harmonics.
        let maxHps = 0;
        let maxIndex = minBin;
        for (let i = minBin; i <= maxBin; i++) {
          const h2 = i * 2 < spectrum.length ? spectrum[i * 2] : 1;
          const h3 = i * 3 < spectrum.length ? spectrum[i * 3] : 1;
          const hps = spectrum[i] * h2 * h3;
          if (hps > maxHps) {
            maxHps = hps;
            maxIndex = i;
          }
        }

        if (maxHps === 0) return 0;

        // Parabolic interpolation around the peak for sub-bin frequency accuracy.
        let interpolatedIndex = maxIndex;
        if (maxIndex > minBin && maxIndex < spectrum.length - 1) {
          const alpha = spectrum[maxIndex - 1];
          const beta  = spectrum[maxIndex];
          const gamma = spectrum[maxIndex + 1];
          const denom = alpha - 2 * beta + gamma;
          if (Math.abs(denom) > 1e-10) {
            const offset = 0.5 * (alpha - gamma) / denom;
            interpolatedIndex = maxIndex + Math.max(-0.5, Math.min(0.5, offset));
          }
        }

        const frequency = interpolatedIndex * binSize;
        return (frequency >= 80 && frequency <= 1000) ? frequency : 0;
      } catch (error) {
        console.warn('Error calculating pitch:', error);
        return 0;
      }
    },

    // Group consecutive voiced frames into note events.
    // A new group starts when:
    //   • an onset is detected via spectral flux, OR
    //   • there is a gap > 120 ms between frames (silence), OR
    //   • pitch shifts by more than ~1.5 semitones relative to the group start.
    _groupIntoNoteEvents(features) {
      if (features.length === 0) return [];

      const SEMITONE_1_5 = Math.pow(2, 1.5 / 12); // ≈ 1.091
      const MAX_GAP_S = 0.12;

      const groups = [];
      let group = [features[0]];

      for (let i = 1; i < features.length; i++) {
        const f    = features[i];
        const prev = features[i - 1];
        const ratio = f.pitch / group[0].pitch;
        const gap   = f.time - prev.time;

        const newNote = f.isOnset
          || gap > MAX_GAP_S
          || ratio < 1 / SEMITONE_1_5
          || ratio > SEMITONE_1_5;

        if (newNote) {
          groups.push(group);
          group = [f];
        } else {
          group.push(f);
        }
      }
      groups.push(group);
      return groups;
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

    smoothNotes(noteGroups) {
      if (this.noteSmoothing === 0) return noteGroups;

      const smoothing = this.noteSmoothing / 100;

      // Minimum frames a group must have — scales up to ~130 ms worth at 100%.
      // Hop size is 512/44100 ≈ 11.6 ms, so 11 frames ≈ 128 ms.
      const minFrames = Math.round(smoothing * 11);

      // Pitch ratio window for merging adjacent groups.
      // At 100 % smoothing, merge groups within 2 semitones of each other.
      const mergeRatio = Math.pow(2, (smoothing * 2) / 12);

      const groupMedian = g => {
        const s = g.map(f => f.pitch).sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };

      // 1. Drop groups that are too short.
      const filtered = noteGroups.filter(g => g.length >= Math.max(1, minFrames));
      if (filtered.length === 0) return filtered;

      // 2. Merge adjacent groups whose median pitches are close.
      const merged = [filtered[0]];
      for (let i = 1; i < filtered.length; i++) {
        const prev = merged[merged.length - 1];
        const curr = filtered[i];
        const ratio = groupMedian(curr) / groupMedian(prev);
        if (ratio >= 1 / mergeRatio && ratio <= mergeRatio) {
          merged[merged.length - 1] = prev.concat(curr);
        } else {
          merged.push(curr);
        }
      }

      return merged;
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
