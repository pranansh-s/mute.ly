import { YouTubeDOM } from '../core/youtube/youtube-dom';
import { BASE_CONTAINER_STYLE, SUBTITLE_TEXT_STYLE, LOADING_INDICATOR_STYLE } from './overlay-styles';

export class SubtitleOverlay {
  private container: HTMLDivElement | null = null;
  private textElement: HTMLSpanElement | null = null;
  private loadingElement: HTMLDivElement | null = null;
  private mode: 'live' | 'vod' = 'vod';

  constructor() {}

  public setMode(mode: 'live' | 'vod') {
    this.mode = mode;
    if (this.container) {
      this.container.style.transition = mode === 'live' ? 'opacity 0.2s ease-in-out' : 'opacity 0.35s ease-in-out';
    }
    if (this.textElement) {
      if (mode === 'live') {
        this.textElement.style.boxShadow = '0 0 12px rgba(255, 0, 0, 0.6)';
        this.textElement.style.border = '1px solid rgba(255, 0, 0, 0.3)';
      } else {
        this.textElement.style.boxShadow = 'none';
        this.textElement.style.border = 'none';
      }
    }
  }

  public checkAndInject = () => {
    if (this.container && document.body.contains(this.container)) return;
    if (this.container) this.destroy();

    const playerContainer = YouTubeDOM.getPlayerContainer();
    if (!playerContainer) return;

    this.container = document.createElement('div');
    this.container.id = 'mutely-subtitle-overlay';

    Object.assign(this.container.style, {
      ...BASE_CONTAINER_STYLE,
      bottom: '10%',
      zIndex: '9999',
      transition: this.mode === 'live' ? 'opacity 0.2s ease-in-out' : 'opacity 0.35s ease-in-out',
    });

    this.textElement = document.createElement('span');
    Object.assign(this.textElement.style, SUBTITLE_TEXT_STYLE);

    if (this.mode === 'live') {
      this.textElement.style.boxShadow = '0 0 12px rgba(255, 0, 0, 0.6)';
      this.textElement.style.border = '1px solid rgba(255, 0, 0, 0.3)';
    }

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
      this.loadingElement.textContent = 'Mute.ly: Loading model...';
      this.container.appendChild(this.loadingElement);
    }

    this.container.style.opacity = '1';
    if (this.textElement) this.textElement.style.display = 'none';
  }

  public updateLoadingProgress(progress: number) {
    if (this.loadingElement) {
      this.loadingElement.textContent = `Mute.ly: Loading model... ${progress}%`;
    }
  }

  public hideLoading() {
    if (this.loadingElement) {
      this.loadingElement.remove();
      this.loadingElement = null;
    }
    if (this.textElement) this.textElement.style.display = 'inline-block';
    if (this.container) this.container.style.opacity = '0';
  }

  public renderText(text: string, isPartial: boolean = false) {
    if (this.container && !document.body.contains(this.container)) {
      this.destroy();
    }

    if (!this.container || !this.textElement) {
      this.checkAndInject();
    }

    if (!this.container || !this.textElement) return;

    const cleanText = text ? text.trim() : '';

    if (cleanText === '') {
      if (this.container.style.opacity !== '0') {
        this.container.style.opacity = '0';
      }
      return;
    }

    if (this.textElement.textContent === cleanText && this.container.style.opacity === '1') {
      return;
    }

    this.textElement.textContent = cleanText;
    this.container.style.opacity = '1';
    this.textElement.style.color = isPartial ? '#cccccc' : '#ffffff';
  }

  public clear() {
    if (this.container) {
      this.container.style.opacity = '0';
    }
    if (this.textElement) {
      this.textElement.textContent = '';
    }
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
