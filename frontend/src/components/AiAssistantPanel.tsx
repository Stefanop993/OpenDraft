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

/** The instructions and the script context the model gets on every turn. */
function systemPrompt(context: unknown): string {
  const tools = commandTools().tools
    .map((tool) => `- ${tool.function.name}: ${tool.function.description}`)
    .join('\n');
  return [
    'Sei l\'assistente di OpenDraft, un\'app di sceneggiatura.',
    'Rispondi in italiano, in modo breve e concreto.',
    'Per modificare il copione usa SEMPRE gli strumenti disponibili: non incollare mai testo formattato nella risposta.',
    'Per un dialogo chiama script_insertDialogue con character e text; non aggiungere intestazioni, indentazioni o maiuscole: le gestisce l\'app.',
    'Se non puoi chiamare gli strumenti, rispondi SOLO con JSON, senza testo attorno:',
    '{"tool":"script_insertDialogue","args":{"character":"BEN","text":"Ciao a tutti."}}',
    'Per più azioni: {"actions":[{"tool":"...","args":{...}}, ...]}.',
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

  const runCalls = useCallback((adapter: ReturnType<typeof createTiptapAdapter>, calls: AiToolCall[]): string[] => {
    const lines: string[] = [];
    for (const call of calls) {
      const result = executeCommand(resolveCommand(call.name), call.args, adapter);
      lines.push(result.ok ? result.message : `Non ho potuto: ${result.message}`);
    }
    return lines;
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
      const history = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-10)
        .map((m): AiChatMessage => ({ role: m.role, content: m.content }));
      const conversation: AiChatMessage[] = [
        { role: 'system', content: systemPrompt(context) },
        ...history,
        { role: 'user', content: prompt },
      ];

      const executed: string[] = [];
      for (let step = 0; step < MAX_STEPS; step++) {
        const reply = await callModel(
          settings,
          conversation,
          settings.provider === 'ollama' ? tools.tools : [],
        );

        if (reply.toolCalls.length > 0) {
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
          executed.push(...runCalls(adapter, actions));
          addMessage('assistant', executed.join(' ') || 'Fatto.');
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
            <code> http://localhost:8080/v1</code>. Se Ollama rifiuta la richiesta per CORS,
            avvialo con <code>OLLAMA_ORIGINS=*</code>.
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
