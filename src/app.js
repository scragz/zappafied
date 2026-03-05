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
    isReady: false,
    isAnalyzed: false,
    noiseThreshold: 0.02,
    quantizeLevel: "16",
    pitchSmoothing: 50,
    midiInstrument: "1",
    currentSynth: null,

    async handleFileUpload(event) {
      const file = event.target.files[0];
      if (!file || !file.type.startsWith('audio/')) {
        alert('Please upload a valid audio file.');
        return;
      }

      this.resetData();
      this.audioSrc = URL.createObjectURL(file);
      this.isReady = true;

      // Set up audio player
      const audioPlayer = document.getElementById('audioPlayer');
      audioPlayer.src = this.audioSrc;

      // Pre-load Tone.js but don't initialize synth yet
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

        // Stop any current playback and cleanup
        const audioPlayer = document.getElementById('audioPlayer');
        if (audioPlayer) {
          audioPlayer.pause();
          audioPlayer.currentTime = 0;
        }

        // Stop Tone.js and cleanup synth
        try {
          const Tone = await getTone();
          Tone.Transport.stop();
          Tone.Transport.cancel();

          if (this.currentSynth) {
            const synth = this.currentSynth;
            this.currentSynth = null;
            try { synth.releaseAll(); } catch (e) {}
            try { synth.dispose(); } catch (e) {}
          }
        } catch (error) {
          console.warn('Error stopping Tone.js:', error);
        }

        // Reset data but keep settings
        this.features = [];
        this.midiData = [];
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

        // Create temporary context for decoding
        console.log('Decoding audio data...');
        const tempContext = new AudioContext();
        const audioBuffer = await tempContext.decodeAudioData(arrayBuffer);
        await tempContext.close();

        console.log('Creating offline context...');
        this.offlineContext = new OfflineAudioContext({
          numberOfChannels: audioBuffer.numberOfChannels,
          length: audioBuffer.length,
          sampleRate: audioBuffer.sampleRate
        });

        const source = this.offlineContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.offlineContext.destination);
        source.start();

        // Process the audio in chunks
        console.log('Processing audio...');
        const bufferSize = 2048; // Must be power of 2
        const sampleRate = audioBuffer.sampleRate;
        const totalSamples = audioBuffer.length;
        const channelData = new Float32Array(audioBuffer.length);
        audioBuffer.copyFromChannel(channelData, 0);

        let features = [];
        for (let startSample = 0; startSample < totalSamples; startSample += bufferSize) {
          const endSample = Math.min(startSample + bufferSize, totalSamples);
          // Ensure chunk size is power of 2
          const chunkSize = Math.pow(2, Math.floor(Math.log2(endSample - startSample)));
          if (chunkSize < 64) continue; // Skip chunks that are too small

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

        // After feature extraction, before MIDI generation:
        if (features.length > 0) {
          // Apply pitch smoothing
          const pitches = features.map(f => f.pitch);
          const smoothedPitches = this.smoothPitch(pitches);
          features = features.map((f, i) => ({
            ...f,
            pitch: smoothedPitches[i]
          }));

          // Apply quantization
          features = features.map(f => ({
            ...f,
            time: this.quantizeTime(f.time)
          }));

          // Remove duplicates after quantization
          features = features.filter((f, i, arr) => {
            if (i === 0) return true;
            const prev = arr[i - 1];
            return !(Math.abs(f.time - prev.time) < 0.01 &&
                    Math.abs(f.pitch - prev.pitch) < 10);
          });
        }

        console.log(`Analysis complete. Found ${features.length} features`);

        // Sort features by time and add to instance
        this.features = features.sort((a, b) => a.time - b.time);

        // Generate MIDI data
        this.features.forEach(feature => {
          this.generateMIDI(feature.pitch, feature.time, feature.rms);
        });

        console.log(`Generated ${this.midiData.length} MIDI notes`);

        // Update visualization and state
        this.drawVisualization();
        this.isAnalyzed = true;
        this.setupPlayback();

      } catch (error) {
        console.error('Error analyzing audio:', error);
        alert(`Analysis failed: ${error.message}`);
      } finally {
        this.isProcessing = false;
      }
    },

    setupPlayback() {
      const audioPlayer = document.getElementById('audioPlayer');
      const newAudioPlayer = audioPlayer.cloneNode(true);
      audioPlayer.parentNode.replaceChild(newAudioPlayer, audioPlayer);

      const disposeSynth = async () => {
        const Tone = await getTone();
        Tone.Transport.stop();
        Tone.Transport.cancel();
        if (this.currentSynth) {
          const synth = this.currentSynth;
          this.currentSynth = null;
          try { synth.releaseAll(); } catch (e) {}
          try { synth.dispose(); } catch (e) {}
        }
      };

      const scheduleNotes = async (startFromTime) => {
        const Tone = await getTone();
        await Tone.start();

        // Cancel any previously scheduled Transport events
        Tone.Transport.stop();
        Tone.Transport.cancel();

        // Dispose existing synth to avoid InvalidStateError from stale audio nodes
        if (this.currentSynth) {
          const oldSynth = this.currentSynth;
          this.currentSynth = null;
          try { oldSynth.releaseAll(); } catch (e) {}
          try { oldSynth.dispose(); } catch (e) {}
        }

        // Create fresh synth with clean audio nodes
        const synthType = parseInt(this.midiInstrument);
        if (synthType >= 9 && synthType <= 16) {
          this.currentSynth = new Tone.PolySynth(Tone.MetalSynth).toDestination();
        } else {
          this.currentSynth = new Tone.PolySynth(Tone.Synth, {
            envelope: { attack: 0.005, decay: 0.1, sustain: 0.3, release: 0.1 }
          }).toDestination();
        }

        // Capture synth ref so callbacks can detect stale synths
        const synth = this.currentSynth;

        this.midiData.forEach(event => {
          if (event.time >= startFromTime) {
            Tone.Transport.scheduleOnce((time) => {
              if (synth === this.currentSynth && this.currentSynth) {
                try {
                  this.currentSynth.triggerAttackRelease(
                    Tone.Frequency(event.note, "midi").toFrequency(),
                    "8n",
                    time,
                    event.velocity ? event.velocity / 127 : 0.7
                  );
                } catch (e) {
                  console.warn('Error playing note:', event.note, e);
                }
              }
            }, event.time - startFromTime);
          }
        });

        Tone.Transport.start();
      };

      newAudioPlayer.addEventListener('play', async () => {
        try {
          await scheduleNotes(newAudioPlayer.currentTime);
        } catch (error) {
          console.error('Error during MIDI playback:', error);
        }
      });

      newAudioPlayer.addEventListener('pause', async () => {
        try {
          const Tone = await getTone();
          Tone.Transport.pause();
          if (this.currentSynth) {
            try { this.currentSynth.releaseAll(); } catch (e) {}
          }
        } catch (e) {}
      });

      newAudioPlayer.addEventListener('seeked', async () => {
        if (!newAudioPlayer.paused) {
          try {
            await scheduleNotes(newAudioPlayer.currentTime);
          } catch (error) {
            console.error('Error rescheduling after seek:', error);
          }
        }
      });

      newAudioPlayer.addEventListener('ended', () => { disposeSynth(); });

      window.addEventListener('beforeunload', () => { disposeSynth(); });
    },

    calculatePitch(spectrum, sampleRate) {
      try {
        if (!spectrum || spectrum.length === 0) return 0;

        const binSize = sampleRate / (spectrum.length * 2);
        let maxIndex = 0;
        let maxValue = 0;

        // Find the peak frequency
        for (let i = 0; i < spectrum.length; i++) {
          if (spectrum[i] > maxValue) {
            maxValue = spectrum[i];
            maxIndex = i;
          }
        }

        // Convert bin index to frequency
        const frequency = maxIndex * binSize;

        // Only return frequencies in the vocal range (roughly 80-1000 Hz)
        return (frequency >= 80 && frequency <= 1000) ? frequency : 0;
      } catch (error) {
        console.warn('Error calculating pitch:', error);
        return 0;
      }
    },

    generateMIDI(pitch, time, velocity) {
      // Convert frequency to MIDI with proper rounding
      const midiNote = Math.round(69 + 12 * Math.log2(pitch / 440));

      // Ensure MIDI note is within valid range and not a duplicate
      if (midiNote >= 21 && midiNote <= 108) { // Standard piano range
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

      // Force minimum canvas dimensions if not set by CSS
      const minWidth = 600;
      const minHeight = 400;

      // Set canvas size to match its display size or minimum dimensions
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = Math.max(rect.width || minWidth, minWidth);
      canvas.height = Math.max(rect.height || minHeight, minHeight);

      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;

      console.log('Canvas dimensions set to:', width, height);

      // Clear canvas
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, width, height);

      // Calculate scaling factors
      const duration = this.features[this.features.length - 1].time;
      const pitchValues = this.features.map(f => f.pitch);
      const minPitch = Math.min(...pitchValues);
      const maxPitch = Math.max(...pitchValues);
      const pitchRange = maxPitch - minPitch || 1;

      // Set margins
      const margin = {
        left: 60,
        right: 20,
        top: 20,
        bottom: 40
      };

      const plotWidth = width - margin.left - margin.right;
      const plotHeight = height - margin.top - margin.bottom;

      // Draw grid
      ctx.strokeStyle = '#eee';
      ctx.lineWidth = 0.5;

      // Vertical grid lines
      for (let i = 0; i <= 10; i++) {
        const x = margin.left + (plotWidth * i / 10);
        ctx.beginPath();
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, height - margin.bottom);
        ctx.stroke();
      }

      // Horizontal grid lines
      for (let i = 0; i <= 10; i++) {
        const y = margin.top + (plotHeight * i / 10);
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(width - margin.right, y);
        ctx.stroke();
      }

      // Draw axes
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;

      // Y-axis
      ctx.beginPath();
      ctx.moveTo(margin.left, margin.top);
      ctx.lineTo(margin.left, height - margin.bottom);
      ctx.stroke();

      // X-axis
      ctx.beginPath();
      ctx.moveTo(margin.left, height - margin.bottom);
      ctx.lineTo(width - margin.right, height - margin.bottom);
      ctx.stroke();

      // Plot points
      this.features.forEach((feature, i) => {
        // Scale coordinates to plot area
        const x = margin.left + (plotWidth * feature.time / duration);
        const y = (height - margin.bottom) - (plotHeight * (feature.pitch - minPitch) / pitchRange);

        const radius = Math.max(3, feature.rms * 15);

        // Draw connection to previous point
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

        // Draw point
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fillStyle = `hsla(${(feature.pitch % 12) * 30}, 70%, 50%, 0.8)`;
        ctx.fill();
      });

      // Draw axis labels
      ctx.fillStyle = 'black';
      ctx.font = '12px Arial';

      // Y-axis labels (frequency)
      for (let i = 0; i <= 5; i++) {
        const pitch = minPitch + (pitchRange * i / 5);
        const y = margin.top + plotHeight * (1 - i / 5);
        ctx.textAlign = 'right';
        ctx.fillText(Math.round(pitch) + 'Hz', margin.left - 5, y + 4);
      }

      // X-axis labels (time)
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

        // Add track name and instrument
        track.addEvent([
          new MidiWriter.ProgramChangeEvent({instrument: parseInt(this.midiInstrument)}),
          new MidiWriter.TrackNameEvent({text: 'Zappafied Voice'})
        ]);

        // Convert time-based events to ticks with proper duration
        const ticksPerBeat = 128;
        const beatsPerSecond = 2; // Assuming 120 BPM

        this.midiData.forEach((event, index) => {
          const startTick = Math.round(event.time * ticksPerBeat * beatsPerSecond);
          const duration = '8'; // eighth note duration

          const note = new MidiWriter.NoteEvent({
            pitch: [Tone.Frequency(event.note, "midi").toNote()],
            duration: duration,
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

    deleteNote(index) {
      this.midiData.splice(index, 1);
      this.drawVisualization();
    },

    async updateNoteDisplay() {
      try {
        const Tone = await getTone();
        const notesList = document.querySelectorAll('[x-text^="Tone.Frequency"]');
        notesList.forEach(noteElement => {
          const note = parseInt(noteElement.getAttribute('data-note'));
          noteElement.textContent = Tone.Frequency(note, "midi").toNote();
        });
      } catch (error) {
        console.error('Error updating note display:', error);
      }
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

      const quarterNote = 60 / 120; // Assuming 120 BPM
      const division = parseInt(this.quantizeLevel);
      // division is the note denominator (8 = 1/8 note, 16 = 1/16 note, etc.)
      // 1/8 note = quarterNote/2, 1/16 = quarterNote/4, 1/32 = quarterNote/8
      const gridSize = (4 * quarterNote) / division;

      return Math.round(time / gridSize) * gridSize;
    }
  }
}
