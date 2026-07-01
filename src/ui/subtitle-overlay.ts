import { YouTubeDOM } from '../core/youtube/youtube-dom';
import { BASE_CONTAINER_STYLE, SUBTITLE_TEXT_STYLE, LOADING_INDICATOR_STYLE } from './overlay-styles';

export class SubtitleOverlay {
  private container: HTMLDivElement | null = null;
  private textElement: HTMLSpanElement | null = null;
  private loadingElement: HTMLDivElement | null = null;
  private mode: 'live' | 'vod' = 'vod';
  private device: 'webgpu' | 'wasm' | null = null;
  private loadProgress = 0;
  private lastText = '';

  constructor() {}

  public setDevice(device: 'webgpu' | 'wasm') {
    this.device = device;
    this.refreshLoadingText();
  }

  public setMode(mode: 'live' | 'vod') {
    this.mode = mode;
    if (this.container) {
      this.container.style.transition = mode === 'live' ? 'opacity 0.2s ease-in-out' : 'opacity 0.12s ease-in-out';
    }
  }

  public checkAndInject = () => {
    if (this.container && document.body.contains(this.container)) return;
    if (this.container) this.destroy();
    this.lastText = '';

    const playerContainer = YouTubeDOM.getPlayerContainer();
    if (!playerContainer) return;

    this.container = document.createElement('div');
    this.container.id = 'mutely-subtitle-overlay';

    Object.assign(this.container.style, {
      ...BASE_CONTAINER_STYLE,
      bottom: '10%',
      zIndex: '9999',
      transition: this.mode === 'live' ? 'opacity 0.2s ease-in-out' : 'opacity 0.12s ease-in-out',
    });

    this.textElement = document.createElement('span');
    Object.assign(this.textElement.style, SUBTITLE_TEXT_STYLE);

    this.container.appendChild(this.textElement);
    playerContainer.appendChild(this.container);
  }

  public showLoading() {
    this.checkAndInject();
    if (!this.container) return;

    if (!this.loadingElement) {
      this.loadingElement = document.createElement('div');
      this.loadingElement.id = 'mutely-loading-indicator';
      Object.assign(this.loadingElement.style, LOADING_INDICATOR_STYLE);
      this.container.appendChild(this.loadingElement);
    }
    this.refreshLoadingText();
    this.container.style.opacity = '1';
    if (this.textElement) this.textElement.style.display = 'none';
  }

  public updateLoadingProgress(progress: number) {
    this.loadProgress = progress;
    this.refreshLoadingText();
  }

  private refreshLoadingText() {
    if (!this.loadingElement) return;
    const deviceLabel = this.device === 'webgpu' ? ' (WebGPU)' : this.device === 'wasm' ? ' (CPU)' : '';
    const progress = this.loadProgress > 0 ? ` ${this.loadProgress}%` : '';
    this.loadingElement.textContent = `Mute.ly: Loading model${deviceLabel}...${progress}`;
  }

  public hideLoading() {
    if (this.loadingElement) {
      this.loadingElement.remove();
      this.loadingElement = null;
    }
    if (this.textElement) this.textElement.style.display = 'inline-block';
    if (this.container) this.container.style.opacity = '0';
  }

  public renderText(committed: string, _tentative: string = '') {
    if (this.container && !document.body.contains(this.container)) {
      this.destroy();
    }
    if (!this.container || !this.textElement) {
      this.checkAndInject();
    }
    if (!this.container || !this.textElement) return;

    const text = (committed || '').trim();

    if (text === '') {
      if (this.lastText === '') return;
      this.lastText = '';
      this.container.style.opacity = '0';
      this.textElement.textContent = '';
      return;
    }

    if (text !== this.lastText) {
      renderMultiLine(this.textElement, text);
      this.lastText = text;
    }
    if (this.container.style.opacity !== '1') this.container.style.opacity = '1';
  }

  public clear() {
    if (this.container) this.container.style.opacity = '0';
    if (this.textElement) this.textElement.textContent = '';
    this.lastText = '';
  }

  destroy() {
    this.hideLoading();
    if (this.container?.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
    this.textElement = null;
  }
}

function renderMultiLine(element: HTMLElement, text: string) {
  element.textContent = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) element.appendChild(document.createElement('br'));
    element.appendChild(document.createTextNode(lines[i]));
  }
}
