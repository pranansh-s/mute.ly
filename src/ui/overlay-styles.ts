export const OVERLAY_FONT: Partial<CSSStyleDeclaration> = {
  backgroundColor: 'rgba(20, 20, 25, 0.85)',
  padding: '6px 14px',
  borderRadius: '8px',
  fontFamily: '"YouTube Noto", Roboto, Arial, sans-serif',
  fontWeight: '500',
  display: 'inline-block',
};

export const BASE_CONTAINER_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  width: '80%',
  textAlign: 'center',
  pointerEvents: 'none',
  transition: 'opacity 0.12s ease-in-out',
  opacity: '0',
};

export const SUBTITLE_TEXT_STYLE: Partial<CSSStyleDeclaration> = {
  ...OVERLAY_FONT,
  color: '#fff',
  fontSize: '20px',
  lineHeight: '1.4',
  maxWidth: 'min(80%, 720px)',
  display: 'inline-block',
  textAlign: 'center',
  whiteSpace: 'pre-line',
  wordBreak: 'normal',
  overflowWrap: 'break-word',
};

export const LOADING_INDICATOR_STYLE: Partial<CSSStyleDeclaration> = {
  ...OVERLAY_FONT,
  color: '#ffa726',
  fontSize: '14px',
};

export const ERROR_MODAL_STYLE: Partial<CSSStyleDeclaration> = {
  ...OVERLAY_FONT,
  backgroundColor: 'rgba(30, 10, 10, 0.95)',
  border: '1px solid rgba(239, 83, 80, 0.4)',
  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
  maxWidth: '500px',
  textAlign: 'center',
  display: 'flex',
  margin: '0 auto',
  flexDirection: 'column',
  gap: '4px',
  padding: '12px 20px',
};

export const ERROR_TITLE_STYLE: Partial<CSSStyleDeclaration> = {
  color: '#ef5350',
  fontSize: '16px',
  fontWeight: 'bold',
};

export const ERROR_ADVICE_STYLE: Partial<CSSStyleDeclaration> = {
  color: '#ffccbc',
  fontSize: '13px',
  fontWeight: 'normal',
};

export const ERROR_RETRY_STYLE: Partial<CSSStyleDeclaration> = {
  color: '#9e9e9e',
  fontSize: '11px',
  marginTop: '6px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px'
};
