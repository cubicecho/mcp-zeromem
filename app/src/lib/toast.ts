import { toast } from 'sonner';
import { ApiRequestError } from './api';

/** Standard error toast for failed mutations — includes the API detail when present. */
export function toastApiError(error: unknown): void {
  if (error instanceof ApiRequestError) {
    toast.error(error.message, { description: error.detail });
    return;
  }
  toast.error(error instanceof Error ? error.message : String(error));
}
