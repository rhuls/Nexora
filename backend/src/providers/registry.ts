import type { IDataProvider } from './types.js';

export class ProviderRegistry {
  private readonly providers = new Map<string, IDataProvider>();

  constructor(providers: IDataProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: IDataProvider): void {
    if (this.providers.has(provider.source)) throw new Error(`Provider '${provider.source}' is already registered`);
    this.providers.set(provider.source, provider);
  }

  get(source: string): IDataProvider {
    const provider = this.providers.get(source);
    if (!provider) throw new Error(`No data provider registered for source '${source}'`);
    return provider;
  }

  list(): IDataProvider[] {
    return [...this.providers.values()];
  }
}
