export class SubtitleOverlay {
  private container: HTMLDivElement | null = null;
  private textElement: HTMLSpanElement | null = null;

  constructor() {
    this.injectOverlay();
  }

  private injectOverlay() {
    if (this.container) return;

    const playerContainer = document.querySelector('.html5-video-player');
    if (!playerContainer) return;

    this.container = document.createElement('div');
    this.container.id = 'mutely-subtitle-overlay';

    Object.assign(this.container.style, {
      textAlign: 'center',
      zIndex: '9999',
      transition: 'opacity 0.2s ease-in-out',
      opacity: '0',
    });

    this.textElement = document.createElement('span');
    Object.assign(this.textElement.style, {
      backgroundColor: 'rgba(20, 20, 25, 0.85)',
      color: '#fff',
      padding: '8px 16px',
      borderRadius: '8px',
      fontFamily: '"YouTube Noto", Roboto, Arial, sans-serif',
      fontSize: '24px',
      fontWeight: '500',
      textShadow: '0px 2px 4px rgba(0,0,0,0.8)',
      border: '1px solid rgba(255, 64, 129, 0.4)',
      boxShadow: '0 4px 12px rgba(255, 64, 129, 0.15)',
      display: 'inline-block',
      lineHeight: '1.4'
    });

    this.container.appendChild(this.textElement);
    playerContainer.appendChild(this.container);
  }

  public renderText(text: string, isPartial: boolean = false) {
    if (!this.container || !this.textElement) {
      this.injectOverlay();
    }

    if (!this.container || !this.textElement) return;

    if (!text || text.trim() === '') {
      this.container.style.opacity = '0';
      return;
    }

    this.container.style.opacity = '1';

    this.textElement.style.color = '#ffffff';
    this.textElement.style.border = '1px solid rgba(255, 64, 129, 0.4)';
    this.textElement.style.boxShadow = '0 4px 12px rgba(255, 64, 129, 0.15)';
    this.textElement.textContent = text;
  }

  public clear() {
    if (this.container) {
      this.container.style.opacity = '0';
    }
    if (this.textElement) {
      this.textElement.textContent = '';
    }
  }

  public destroy() {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
    this.textElement = null;
  }
}
