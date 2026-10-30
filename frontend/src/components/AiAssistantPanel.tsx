/**
 * The in-app AI assistant.
 *
 * It is a small agent loop, not a chat that pastes text: the model is given the
 * command layer as tools, calls `script.insertDialogue` (or another command),
 * and the editor builds the cue and the line with the right formatting. When
 * the provider cannot call tools — Unsloth Studio, LM Studio, most local
 * OpenAI-compatible servers — the model is asked for one JSON action instead,
 * and the same command runs.
 *
 * Everything stays on the machine: the panel only talks to the URL configured
 * in its settings.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  FaRobot, FaPaperPlane, FaCog, FaTrashAlt, FaSyncAlt, FaTimes,
} from 'react-icons/fa';
import { useAiStore, AI_PROVIDER_LABELS } from '../stores/aiStore';
import { commandTools, createTiptapAdapter, executeCommand } from '../commands';
import {
  callModel,
  listModels,
  parseJsonActions,
  toolResultMessage,
  DEFAULT_OLLAMA_URL,
  DEFAULT_OPENAI_URL,
  DEFAULT_UNSLOTH_URL,
  type AiChatMessage,
  type AiToolCall,
  type AiSettings,
} from '../services/ai/provider';

interface Props {
  editor: Editor | null;
  style?: React.CSSProperties;
}

const EXAMPLES = [
  'Scrivi un dialogo di Ben che dice «Ciao a tutti».',
  'Aggiungi una scena: INT. LAVANDERIA - NOTTE, con un\'azione iniziale.',
  'Fai dire a MARGO «Non dovevi tornare» con una parentetica «sottovoce».',
];

const MAX_STEPS = 6;
const MAX_REPLY_CHARS = 12_000;

/**
 * A small local model gets confused by eleven similarly named tools. In JSON
 * mode the prompt lists only the six that cover writing: dialogue (which takes
 * the optional parenthetical and extension), action, scene, transition, the
 * element change and replacing the selection. The rest stay available to the
 * command layer and to native-tool providers.
 */
const CORE_JSON_TOOLS = new Set([
  'script_insertDialogue',
  'script_insertAction',
  'script_insertScene',
  'script_insertTransition',
  'editor_setElement',
  'editor_replaceSelection',
]);

/**
 * The instructions and the script context the model gets on every turn.
 *
 * A model that is told "use a tool, or JSON if you cannot" tends to answer
 * "Inserted …" after seeing an earlier confirmation in the conversation; then
 * nothing is inserted. It is told that the app does the inserting, and that
 * JSON is the reply only when no tools arrive.
 */
function systemPrompt(context: unknown, openAiCompatible: boolean): string {
  const tools = commandTools().tools
    .filter((tool) => !openAiCompatible || CORE_JSON_TOOLS.has(tool.function.name))
    .map((tool) => `- ${tool.function.name}: ${tool.function.description}`)
    .join('\n');
  return [
    'Sei l\'assistente di OpenDraft, un\'app di sceneggiatura.',
    'Rispondi in italiano, in modo breve e concreto.',
    'Per modificare il copione usa gli strumenti disponibili. Se non li ricevi, rispondi SOLO con un oggetto JSON valido, senza testo attorno. Non scrivere mai frasi come "Fatto" o "Inserted": le azioni le esegue l\'app.',
    'Per un dialogo: {"tool":"script_insertDialogue","args":{"character":"<NOME>","text":"<BATTUTA>"}}',
    'Per più azioni: {"actions":[{"tool":"...","args":{...}}, ...]}.',
    'Usa soltanto i nomi e le battute contenuti nella richiesta: non copiare l\'esempio e non riusare battute di turni precedenti.',
    'La battuta va al personaggio che la pronuncia nella richiesta, anche se è nuovo: non sostituirlo con un nome del contesto.',
    'Se la richiesta dice "X dice: ..." o "X: ...", è un dialogo: usa script_insertDialogue con character X, mai un\'azione.',
    'I nomi scritti nella richiesta valgono anche se non sono ancora nel contesto.',
    '',
    'Esempi (stessa forma, non copiare i contenuti):',
    'Richiesta: "Ada dice: La porta era aperta."',
    'Risposta: {"tool":"script_insertDialogue","args":{"character":"ADA","text":"La porta era aperta."}}',
    'Richiesta: "La pioggia cade. Ada dice: Chiudi la porta."',
    'Risposta: {"actions":[{"tool":"script_insertAction","args":{"text":"La pioggia cade."}},{"tool":"script_insertDialogue","args":{"character":"ADA","text":"Chiudi la porta."}}]}',
    'Se la richiesta contiene un\'azione e una battuta, restituisci entrambe in "actions": script_insertAction per quello che si vede, script_insertDialogue per la battuta.',
    'Per un\'azione usa script_insertAction. Per una transizione usa script_insertTransition. Non usare una parentetica per un\'azione o una transizione.',
    'Non aggiungere intestazioni, indentazioni o maiuscole nel testo: le gestisce l\'app.',
    'Non inventare personaggi che non sono nel contesto se non ti viene chiesto.',
    '',
    'Strumenti:',
    tools,
    '',
    'Contesto attuale:',
    JSON.stringify(context ?? {}),
  ].join('\n');
}

function clampReply(text: string): string {
  return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text;
}

const AiAssistantPanel: React.FC<Props> = ({ editor, style }) => {
  const panelOpen = useAiStore((s) => s.panelOpen);
  const setPanelOpen = useAiStore((s) => s.setPanelOpen);
  const settings = useAiStore((s) => s.settings);
  const updateSettings = useAiStore((s) => s.updateSettings);
  const messages = useAiStore((s) => s.messages);
  const addMessage = useAiStore((s) => s.addMessage);
  const clearMessages = useAiStore((s) => s.clearMessages);
  const busy = useAiStore((s) => s.busy);
  const setBusy = useAiStore((s) => s.setBusy);
  const error = useAiStore((s) => s.error);
  const setError = useAiStore((s) => s.setError);

  const [input, setInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Keep the newest message in view as the conversation grows.
  React.useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const tools = useMemo(() => commandTools(), []);

  const resolveCommand = useCallback((name: string): string => {
    // The model may use the sanitised tool name (script_insertDialogue) or the
    // command id (script.insertDialogue); both resolve to the command id.
    return tools.commandForTool.get(name) ?? name;
  }, [tools]);

  const runCalls = useCallback((adapter: ReturnType<typeof createTiptapAdapter>, calls: AiToolCall[]) => {
    const lines: string[] = [];
    const failures: string[] = [];
    let applied = 0;
    for (const call of calls) {
      const result = executeCommand(resolveCommand(call.name), call.args, adapter);
      if (result.ok) {
        lines.push(result.message);
        applied++;
      } else {
        lines.push(`Non ho potuto: ${result.message}`);
        failures.push(result.message);
      }
    }
    return { lines, failures, applied };
  }, [resolveCommand]);

  const send = useCallback(async (promptArg?: string) => {
    const prompt = (promptArg ?? input).trim();
    if (!prompt || busy || !editor || editor.isDestroyed) return;
    setInput('');
    setError(null);
    addMessage('user', prompt);
    setBusy(true);

    try {
      const adapter = createTiptapAdapter(editor);
      const context = executeCommand('script.getContext', {}, adapter).data;
      const openAiCompatible = settings.provider !== 'ollama';
      // The OpenAI-compatible path sends no history: a small local model tends
      // to copy an earlier line instead of writing the new one. The prompt and
      // the context carry everything a command needs.
      const history = openAiCompatible
        ? []
        : messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-10)
          .map((m): AiChatMessage => ({ role: m.role, content: m.content }));
      const conversation: AiChatMessage[] = [
        { role: 'system', content: systemPrompt(context, openAiCompatible) },
        ...history,
        { role: 'user', content: prompt },
      ];

      const executed: string[] = [];
      for (let step = 0; step < MAX_STEPS; step++) {
        const reply = await callModel(
          settings,
          conversation,
          tools.tools,
        );
        if (import.meta.env.DEV) console.warn('[ai] reply', reply.content, reply.toolCalls);

        if (reply.toolCalls.length > 0) {
          if (openAiCompatible) {
            // Unsloth Studio or another OpenAI-compatible server understood the
            // native tools: those calls already carry their arguments, so run
            // them and finish (no tool-result turn to keep ids straight).
            const ran = runCalls(adapter, reply.toolCalls);
            executed.push(...ran.lines);
            addMessage('assistant', executed.join(' ') || 'Fatto.');
            if (ran.failures.length > 0) {
              setError(`Alcune azioni non sono state eseguite: ${ran.failures.join(' ')}`);
            }
            return;
          }
          // Ollama's native tool flow: the assistant message (with its calls)
          // and one tool result per call go back to the model.
          conversation.push(reply.assistantMessage);
          for (const call of reply.toolCalls) {
            const result = executeCommand(resolveCommand(call.name), call.args, adapter);
            conversation.push(toolResultMessage(call.name, result));
            executed.push(result.ok ? result.message : `Non ho potuto: ${result.message}`);
          }
          continue;
        }

        // No native call: a JSON answer (OpenAI-compatible / local models) or
        // ordinary prose.
        const actions = parseJsonActions(reply.content);
        if (actions.length > 0) {
          const ran = runCalls(adapter, actions);
          if (import.meta.env.DEV) console.warn('[ai] ran', ran);
          executed.push(...ran.lines);
          if (ran.applied > 0 || ran.failures.length === 0) {
            addMessage('assistant', executed.join(' ') || 'Fatto.');
            if (ran.failures.length > 0) {
              setError(`Alcune azioni non sono state eseguite: ${ran.failures.join(' ')}`);
            }
            return;
          }
          // Nothing was applied: give a small model one chance to correct the
          // parameters it got wrong (a missing `text`, an unknown element).
          const correction = await callModel(settings, [
            ...conversation,
            reply.assistantMessage,
            {
              role: 'user',
              content: `Le azioni non sono valide: ${ran.failures.join(' ')}. Rispondi di nuovo SOLO con JSON valido, usando i parametri dello schema.`,
            },
          ], []);
          const corrected = parseJsonActions(correction.content);
          if (corrected.length > 0) {
            const second = runCalls(adapter, corrected);
            executed.push(...second.lines);
            addMessage('assistant', executed.join(' ') || 'Fatto.');
            if (second.failures.length > 0) {
              setError(`Alcune azioni non sono state eseguite: ${second.failures.join(' ')}`);
            }
            return;
          }
          setError('Il modello non ha prodotto un\'azione valida. Prova a riformulare la richiesta.');
          addMessage('assistant', executed.join(' ') || 'Nessuna azione valida.');
          return;
        }

        if (openAiCompatible) {
          // One corrective turn: a small local model sometimes answers with a
          // confirmation (or prose) instead of the JSON action.
          const retry = await callModel(settings, [
            ...conversation,
            reply.assistantMessage,
            {
              role: 'user',
              content: 'La risposta non conteneva un\'azione JSON. Rispondi di nuovo SOLO con il JSON dell\'azione, senza testo attorno.',
            },
          ], []);
          const retryActions = parseJsonActions(retry.content);
          if (retryActions.length > 0) {
            const ran = runCalls(adapter, retryActions);
            executed.push(...ran.lines);
            addMessage('assistant', executed.join(' ') || 'Fatto.');
            if (ran.failures.length > 0) {
              setError(`Alcune azioni non sono state eseguite: ${ran.failures.join(' ')}`);
            }
            return;
          }
          setError('Il modello non ha restituito un\'azione JSON. Prova a riformulare o a usare un modello più grande.');
          addMessage('assistant', clampReply(retry.content || reply.content || 'Nessuna azione ricevuta.'));
          return;
        }

        addMessage('assistant', clampReply(reply.content || executed.join(' ') || 'Fatto.'));
        return;
      }

      addMessage('assistant', executed.join(' ') || 'Ho raggiunto il limite di passaggi senza una risposta finale.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      addMessage('assistant', `⚠️ ${message}`);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [
    input, busy, editor, messages, settings, tools, addMessage, setBusy, setError,
    resolveCommand, runCalls,
  ]);

  const refreshModels = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const found = await listModels(settings);
      setModels(found);
      if (found.length > 0 && !found.includes(settings.model)) {
        updateSettings({ model: found[0] });
      }
      if (found.length === 0) setError('Nessun modello trovato: carica un modello nel server e riprova.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, [settings, updateSettings, setError]);

  const applyPreset = (provider: AiSettings['provider'], baseUrl: string) => {
    updateSettings({ provider, baseUrl });
    setModels([]);
  };

  if (!panelOpen) return null;

  return (
    <div className="ai-panel" style={style}>
      <div className="ai-header">
        <span className="ai-title"><FaRobot /> AI Assistant</span>
        <div className="ai-header-actions">
          <button
            className={`ai-icon-btn${settingsOpen ? ' active' : ''}`}
            title="Impostazioni del modello"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <FaCog />
          </button>
          <button
            className="ai-icon-btn"
            title="Nuova conversazione"
            onClick={clearMessages}
            disabled={messages.length === 0 || busy}
          >
            <FaTrashAlt />
          </button>
          <button className="ai-icon-btn" title="Chiudi" onClick={() => setPanelOpen(false)}>
            <FaTimes />
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div className="ai-settings">
          <label className="ai-field">
            <span>Provider</span>
            <select
              className="ai-input"
              value={settings.provider}
              onChange={(e) => {
                const provider = e.target.value as AiSettings['provider'];
                updateSettings({
                  provider,
                  baseUrl: provider === 'ollama' ? DEFAULT_OLLAMA_URL : DEFAULT_UNSLOTH_URL,
                });
                setModels([]);
              }}
            >
              <option value="ollama">{AI_PROVIDER_LABELS.ollama}</option>
              <option value="openai">{AI_PROVIDER_LABELS.openai}</option>
            </select>
          </label>
          <div className="ai-presets">
            <button onClick={() => applyPreset('ollama', DEFAULT_OLLAMA_URL)}>Ollama</button>
            <button onClick={() => applyPreset('openai', DEFAULT_UNSLOTH_URL)}>Unsloth Studio</button>
            <button onClick={() => applyPreset('openai', DEFAULT_OPENAI_URL)}>LM Studio</button>
          </div>
          <label className="ai-field">
            <span>Server</span>
            <input
              className="ai-input"
              value={settings.baseUrl}
              onChange={(e) => updateSettings({ baseUrl: e.target.value })}
              placeholder="http://localhost:11434"
            />
          </label>
          <label className="ai-field">
            <span>Modello</span>
            <div className="ai-model-row">
              <input
                className="ai-input"
                value={settings.model}
                onChange={(e) => updateSettings({ model: e.target.value })}
                placeholder="qwen2.5"
                list="ai-model-list"
              />
              <datalist id="ai-model-list">
                {models.map((m) => <option key={m} value={m} />)}
              </datalist>
              <button
                className="ai-icon-btn"
                title="Leggi i modelli dal server"
                onClick={refreshModels}
                disabled={refreshing}
              >
                <FaSyncAlt className={refreshing ? 'ai-spin' : ''} />
              </button>
            </div>
          </label>
          {settings.provider === 'openai' && (
            <label className="ai-field">
              <span>API key (solo se il server la richiede)</span>
              <input
                className="ai-input"
                type="password"
                value={settings.apiKey}
                onChange={(e) => updateSettings({ apiKey: e.target.value })}
                placeholder="opzionale"
              />
            </label>
          )}
          <p className="ai-hint">
            Ollama: avvia <code>ollama serve</code>. Unsloth Studio espone
            <code> http://localhost:8080/v1</code> e, se l&apos;autenticazione è attiva, richiede un token:
            crealo in <strong>API → Token di accesso → Crea token</strong> e incollalo qui sopra.
            Se Ollama rifiuta la richiesta per CORS, avvialo con <code>OLLAMA_ORIGINS=*</code>.
          </p>
          <p className="ai-hint">
            Per risultati affidabili usa un modello instruct da 7B in su (Qwen2.5-7B-Instruct,
            Llama 3.1 8B): i modelli da 3B sbagliano spesso a chi attribuire una battuta e a
            gestire azioni multiple.
          </p>
        </div>
      )}

      <div className="ai-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="ai-empty">
            <p>Chiedi di scrivere nel copione. L&apos;assistente usa i comandi dell&apos;app,
               quindi il testo arriva già formattato.</p>
            {EXAMPLES.map((example) => (
              <button key={example} className="ai-example" onClick={() => void send(example)}>
                {example}
              </button>
            ))}
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`ai-message ai-${message.role}`}>
            <div className="ai-message-role">{message.role === 'user' ? 'Tu' : 'Assistente'}</div>
            <div className="ai-message-text">{message.content}</div>
          </div>
        ))}
        {busy && (
          <div className="ai-message ai-assistant">
            <div className="ai-message-role">Assistente</div>
            <div className="ai-message-text ai-thinking">Sto scrivendo…</div>
          </div>
        )}
      </div>

      {error && !settingsOpen && <div className="ai-error">{error}</div>}

      <div className="ai-composer">
        <textarea
          ref={inputRef}
          className="ai-input ai-textarea"
          rows={3}
          value={input}
          placeholder="Es. Scrivi un dialogo di Ben che dice «Ciao a tutti»"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={busy}
        />
        <button
          className="ai-send"
          title="Invia (Invio)"
          onClick={() => void send()}
          disabled={busy || !input.trim() || !editor}
        >
          <FaPaperPlane />
        </button>
      </div>
      {!editor && <div className="ai-error">Apri un copione per usare l&apos;assistente.</div>}
    </div>
  );
};

export default AiAssistantPanel;
