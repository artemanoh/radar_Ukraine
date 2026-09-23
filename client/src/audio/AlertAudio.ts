export class AlertAudio {
  private ctx: AudioContext | null = null;
  private oscillator: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private lfoOscillator: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;
  private isPlaying = false;
  
  /**
   * Lazily initialize AudioContext on first user gesture.
   */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }
  
  /**
   * Start siren: sawtooth oscillator at base frequency, modulated by LFO sweeping.
   */
  public start(threatLevel: 1 | 2 | 3): void {
    if (this.isPlaying) return;
    this.isPlaying = true;
    
    const ctx = this.ensureContext();
    
    let baseFreq = 380;
    let sweepRange = 100;
    let lfoRate = 0.3;
    let targetGain = 0.4;
    
    if (threatLevel === 2) {
      baseFreq = 480; sweepRange = 200; lfoRate = 0.5; targetGain = 0.6;
    } else if (threatLevel === 3) {
      baseFreq = 580; sweepRange = 300; lfoRate = 1.0; targetGain = 0.8;
    }
    
    this.oscillator = ctx.createOscillator();
    this.oscillator.type = 'sawtooth';
    this.oscillator.frequency.value = baseFreq;
    
    this.lfoOscillator = ctx.createOscillator();
    this.lfoOscillator.type = 'sine';
    this.lfoOscillator.frequency.value = lfoRate;
    
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = sweepRange;
    
    this.lfoOscillator.connect(this.lfoGain);
    this.lfoGain.connect(this.oscillator.frequency);
    
    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(0, ctx.currentTime);
    this.gain.gain.linearRampToValueAtTime(targetGain, ctx.currentTime + 0.1);
    
    this.oscillator.connect(this.gain);
    this.gain.connect(ctx.destination);
    
    this.lfoOscillator.start();
    this.oscillator.start();
    
    if (navigator.vibrate) {
      navigator.vibrate([300, 100, 300, 100, 300]);
    }
  }
  
  /**
   * Stop siren: gain release 0.3s, then disconnect nodes.
   */
  public stop(): void {
    if (!this.isPlaying || !this.ctx || !this.gain || !this.oscillator || !this.lfoOscillator) return;
    this.isPlaying = false;
    
    const ctx = this.ctx;
    const gainNode = this.gain;
    const oscNode = this.oscillator;
    const lfoNode = this.lfoOscillator;
    const lfoGainNode = this.lfoGain;
    
    gainNode.gain.cancelScheduledValues(ctx.currentTime);
    gainNode.gain.setValueAtTime(gainNode.gain.value, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
    
    setTimeout(() => {
      oscNode.stop();
      lfoNode.stop();
      oscNode.disconnect();
      lfoNode.disconnect();
      if (lfoGainNode) lfoGainNode.disconnect();
      gainNode.disconnect();
    }, 300);
    
    this.oscillator = null;
    this.gain = null;
    this.lfoOscillator = null;
    this.lfoGain = null;
  }
  
  public isActive(): boolean {
    return this.isPlaying;
  }
}
