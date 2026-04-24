export class SubtitleOverlay {
  private container: HTMLDivElement | null = null;
  private textElement: HTMLSpanElement | null = null;

  constructor() {
    this.checkAndInject();
  }

  public checkAndInject = () => {
    if (this.container && document.body.contains(this.container)) return;
    if (this.container) this.destroy();

    const playerContainer = document.querySelector('.html5-video-player');
    if (!playerContainer) return;

    this.container = document.createElement('div');
    this.container.id = 'mutely-subtitle-overlay';

    Object.assign(this.container.style, {
      position: 'absolute',
      bottom: '10%',
      left: '50%',
      transform: 'translateX(-50%)',
      width: '80%',
      textAlign: 'center',
      pointerEvents: 'none',
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
      display: 'inline-block',
      lineHeight: '1.4'
    });

    this.container.appendChild(this.textElement);
    playerContainer.appendChild(this.container);
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
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
    this.textElement = null;
  }
}
