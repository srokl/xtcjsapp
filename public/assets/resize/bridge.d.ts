/**
 * Bridge implementation for the Resize package, handling worker and client modes.
 */
import { type ImageInput } from '@squoosh-kit/runtime';
import type { ResizeOptions } from './types.ts';
export type BridgeOptions = {
    assetPath?: string;
};
interface ResizeBridge {
    resize(image: ImageInput, options: ResizeOptions, signal?: AbortSignal): Promise<ImageInput>;
    terminate(): Promise<void>;
}
export declare function createBridge(mode: 'worker' | 'client', options?: BridgeOptions): ResizeBridge;
export {};
//# sourceMappingURL=bridge.d.ts.map