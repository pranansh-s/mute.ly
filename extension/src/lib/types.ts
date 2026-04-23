export type MonitorStatus = 'idle' | 'audio' | 'error';

export interface InitMessage {
  type: 'init';
  videoId: string;
  isLive: boolean;
}

export interface ServerAckMessage {
  type: 'ack';
  processed?: boolean;
  chunkId?: number;
}

export interface ServerConnectedMessage {
  type: 'connected';
  videoId: string;
}

export type ServerMessage = ServerAckMessage | ServerConnectedMessage;
