import { readFileSync } from 'node:fs';
import { Controller, Get, Header } from '@nestjs/common';

/** Serve a página de demonstração (arquivo estático único, sem build). Aberta, como health/metrics. */
@Controller()
export class UiController {
  private readonly html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-cache')
  index(): string {
    return this.html;
  }
}
