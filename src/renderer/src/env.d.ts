/// <reference types="vite/client" />
import type { ProcWatchApi } from '../../preload';

declare global {
  interface Window {
    procWatch: ProcWatchApi;
  }
}
