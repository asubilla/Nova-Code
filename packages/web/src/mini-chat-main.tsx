import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@novacode/ui/lib/api/types';
import '@novacode/ui/index.css';
import '@novacode/ui/styles/fonts';
import '@novacode/ui/styles/katex-css';

declare global {
  interface Window {
    __NOVACODE_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__NOVACODE_RUNTIME_APIS__ = createConfiguredWebAPIs();

void import('@novacode/ui/apps/renderElectronMiniChatApp')
  .then(({ renderElectronMiniChatApp }) => {
    renderElectronMiniChatApp(window.__NOVACODE_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
  });
