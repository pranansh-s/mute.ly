export interface UIErrorData {
  title: string;
  advice: string;
}

/**
 * Maps arbitrary thrown errors to user-friendly UI error configurations.
 */
export function mapErrorToUI(error: unknown): UIErrorData {
  const errMsg = error instanceof Error ? error.message : String(error);

  if (errMsg.includes('NO_VIDEO')) {
    return {
      title: 'No Video Found',
      advice: 'Could not find a valid video on this page to transcribe.'
    };
  }
  
  if (errMsg.includes('Permission denied') || errMsg.includes('Requested device not found')) {
    return {
      title: 'Microphone Access Denied',
      advice: 'Live extraction requires microphone permissions. Please allow access in your browser settings.'
    };
  }

  return {
    title: 'Unexpected Error',
    advice: 'An unexpected error occurred while starting the pipeline.'
  };
}
