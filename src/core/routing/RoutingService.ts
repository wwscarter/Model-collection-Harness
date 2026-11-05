import { LocalRoutingModel, type LocalRoutingClassification, type RoutingClassifier, type RoutingClassifierStatus } from './LocalRoutingModel';
import { OllamaRoutingBackend, OllamaRoutingError } from './OllamaRoutingBackend';
import { loadRoutingSettings, saveRoutingSettings, validateRoutingSettings, type RoutingSettings } from './RoutingSettings';

type ClassifierContext = Parameters<RoutingClassifier['classify']>[0];
type ClassifierOptions = Parameters<RoutingClassifier['classify']>[1];
type ConfirmedExamples = NonNullable<ClassifierContext['confirmedExamples']>;

/** Owns classifier configuration and lifetime, independently of execution models. */
export class RoutingService implements RoutingClassifier {
  private settings: RoutingSettings;
  private backend?: OllamaRoutingBackend;
  private readonly rules = new LocalRoutingModel();

  constructor(private readonly file: string, private readonly options: { getExamples?: (context: ClassifierContext) => ConfirmedExamples } = {}) {
    this.settings = loadRoutingSettings(file);
    this.backend = this.createBackend(this.settings);
  }

  private createBackend(settings: RoutingSettings): OllamaRoutingBackend | undefined {
    return settings.classifier.mode === 'ollama' ? new OllamaRoutingBackend(settings.classifier) : undefined;
  }

  getConfiguration(): { settings: RoutingSettings; status: RoutingClassifierStatus } {
    return { settings: structuredClone(this.settings), status: this.getStatus() };
  }

  getStatus(): RoutingClassifierStatus {
    return this.backend?.getStatus() ?? this.rules.getStatus();
  }

  save(input: unknown): ReturnType<RoutingService['getConfiguration']> {
    const next = validateRoutingSettings(input);
    const backend = this.createBackend(next);
    try {
      // Disk commit precedes the in-memory switch, so failed writes retain the active service.
      saveRoutingSettings(this.file, next);
    } catch (error) { backend?.dispose(); throw error; }
    const previous = this.backend;
    this.settings = next;
    this.backend = backend;
    previous?.dispose();
    return this.getConfiguration();
  }

  async classify(context: ClassifierContext, options?: ClassifierOptions): Promise<LocalRoutingClassification> {
    const backend = this.backend;
    if (!backend) return this.rules.classify(context, options);
    let confirmedExamples: ConfirmedExamples = [];
    try { confirmedExamples = this.options.getExamples?.(context) ?? []; } catch { /* Feedback must not block classification. */ }
    try { return await backend.classify({ ...context, confirmedExamples }, options); }
    catch (error) {
      options?.signal?.throwIfAborted();
      // Recover a cold/unloaded prefix outside the user's short foreground deadline.
      if (error instanceof OllamaRoutingError && ['cold', 'timeout'].includes(error.code)) void this.warmup(undefined, { ...context, confirmedExamples });
      throw error;
    }
  }

  async probe(input?: unknown, signal?: AbortSignal): Promise<{ status: RoutingClassifierStatus; models: string[] }> {
    const draft = input === undefined ? undefined : validateRoutingSettings(input);
    const temporary = draft ? new OllamaRoutingBackend({ ...draft.classifier, mode: 'ollama' }) : undefined;
    const backend = temporary ?? this.backend ?? new OllamaRoutingBackend({ ...this.settings.classifier, mode: 'ollama' });
    try {
      const status = await backend.probe(signal);
      const models = status.reachable ? await backend.listModels(signal) : [];
      return { status, models };
    } finally {
      if (backend !== this.backend) backend.dispose();
    }
  }

  /** A cold model/prompt must not block Electron startup or the settings save. */
  async warmup(signal?: AbortSignal, context?: ClassifierContext): Promise<void> {
    const backend = this.backend;
    if (!backend) return;
    try { await backend.warmup(signal, context); }
    catch { /* Status retains diagnostics; foreground requests retain the rules fallback. */ }
  }

  dispose(): void { this.backend?.dispose(); }
}
