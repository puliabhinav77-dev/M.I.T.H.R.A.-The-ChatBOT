
    // Configuration for Marked.js
    marked.setOptions({
        highlight: function(code, lang) {
            const language = hljs.getLanguage(lang) ? lang : 'plaintext';
            return hljs.highlight(code, { language }).value;
        },
        langPrefix: 'hljs language-',
        breaks: true,
        gfm: true
    });

    const messagesDiv = document.getElementById("messages");
    const input = document.getElementById("userInput");
    const sendBtn = document.getElementById("sendBtn");
    const loadingIndicator = document.getElementById("loadingIndicator");
    const micBtn = document.getElementById("micBtn");
    const modelSelector = document.getElementById("modelSelector");
    const engineStatusText = document.getElementById("engineStatusText");
    const modelRefreshBtn = document.getElementById("modelRefreshBtn");
    
    let messagesHistory = [];
    let voiceEnabled = true;
    let isListening = false;
    let wasSpoken = false;
    let audioCtx = null;
    let currentAudio = null;  // globally track the playing TTS audio
    let voiceMode = 'friday'; // 'friday' or 'jarvis'
    let currentModel = 'mistral'; // default model

    // ─── MODEL SELECTOR ───
    function formatModelSize(bytes) {
        if (!bytes) return '';
        const gb = bytes / (1024 * 1024 * 1024);
        if (gb >= 1) return gb.toFixed(1) + ' GB';
        const mb = bytes / (1024 * 1024);
        return mb.toFixed(0) + ' MB';
    }

    async function fetchModels() {
        try {
            const response = await fetch('/api/models');
            const data = await response.json();
            if (data.models && data.models.length > 0) {
                modelSelector.innerHTML = '';
                const vmSelector = document.getElementById('vmModelSelector');
                if (vmSelector) vmSelector.innerHTML = '';

                data.models.forEach((model, index) => {
                    const option = document.createElement('option');
                    option.value = model.name;
                    const sizeStr = formatModelSize(model.size);
                    option.textContent = model.name.toUpperCase() + (sizeStr ? ' [' + sizeStr + ']' : '');
                    modelSelector.appendChild(option);

                    if (vmSelector) {
                        const vmOption = document.createElement('option');
                        vmOption.value = model.name;
                        vmOption.textContent = model.name.toUpperCase();
                        vmSelector.appendChild(vmOption);
                    }
                });
                
                // Try to keep current selection, else default to first
                const options = Array.from(modelSelector.options).map(o => o.value);
                if (options.includes(currentModel)) {
                    modelSelector.value = currentModel;
                    if (vmSelector) vmSelector.value = currentModel;
                } else {
                    modelSelector.value = options[0];
                    if (vmSelector) vmSelector.value = options[0];
                    currentModel = options[0];
                }
                updateEngineStatus();
                if (document.getElementById('vmModelName')) {
                    document.getElementById('vmModelName').textContent = currentModel.toUpperCase().substring(0, 10);
                }
            }
        } catch (e) {
            console.error('Failed to fetch models:', e);
            modelSelector.innerHTML = '<option value="mistral">MISTRAL (FALLBACK)</option>';
            const vmSelector = document.getElementById('vmModelSelector');
            if (vmSelector) vmSelector.innerHTML = '<option value="mistral">MISTRAL (FALLBACK)</option>';
            updateEngineStatus();
        }
    }

    function updateEngineStatus() {
        const displayName = currentModel.toUpperCase().replace(':', ' : ');
        engineStatusText.textContent = 'SYS.LINK ESTABLISHED // NEURAL ENGINE: ' + displayName + ' // SECURE CHL OPEN';
    }

    modelSelector.addEventListener('change', function() {
        currentModel = this.value;
        updateEngineStatus();
        playUIBeep(700, 'triangle', 0.04, 0.12);
        // Notify user
        addMessage('Neural engine switched to **' + currentModel + '**. All subsequent queries will be routed through this model.', 'bot');
    });

    async function refreshModels() {
        modelRefreshBtn.classList.add('spinning');
        await fetchModels();
        setTimeout(() => modelRefreshBtn.classList.remove('spinning'), 600);
        playUIBeep(800, 'sine', 0.03, 0.1);
    }
    
    // Web Speech API Setup
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;
    let stoppedByCode = false;   // guards against onend → sendMessage loop
    let silenceTimer = null;     // auto-stop after silence
    let autoSendTimer = null;    // delay before auto-sending so user can see the text
    
    if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.continuous = true;        // continuous mode captures ongoing speech
        recognition.interimResults = true;    // show real-time partial transcription
        recognition.lang = 'en-US';
        recognition.maxAlternatives = 1;

        let originalValue = '';
        let accumulatedFinal = '';   // accumulates final transcript segments

        recognition.onstart = function() {
            isListening = true;
            stoppedByCode = false;
            accumulatedFinal = '';
            micBtn.classList.add("listening");
            input.placeholder = "> 🎤 LISTENING... SPEAK NOW";
            originalValue = input.value;
            if (originalValue !== "" && !originalValue.endsWith(" ")) {
                originalValue += " ";
            }
            wasSpoken = true;
            // Safety: auto-stop after 60s to prevent mic staying open forever
            clearTimeout(silenceTimer);
            silenceTimer = setTimeout(() => {
                if (isListening && recognition) {
                    console.log("Speech timeout – auto-stopping mic");
                    stoppedByCode = true;
                    recognition.stop();
                }
            }, 60000);
        };

        recognition.onresult = function(event) {
            // Reset silence auto-send timer on every result (user is still talking)
            clearTimeout(autoSendTimer);

            let finalText = '';
            let interimText = '';
            for (let i = 0; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalText += event.results[i][0].transcript;
                } else {
                    interimText += event.results[i][0].transcript;
                }
            }

            // Update the textarea with the transcribed text in real time
            const displayText = originalValue + finalText + interimText;
            input.value = displayText;
            input.style.height = 'auto';
            input.style.height = (input.scrollHeight) + 'px';
            input.focus();  // keep focus on textarea so user can see the text

            // Store final text for auto-send logic
            accumulatedFinal = finalText;

            // If we got final text, start a 2-second silence timer to auto-stop & send
            if (finalText.trim() !== '') {
                autoSendTimer = setTimeout(() => {
                    if (isListening && recognition) {
                        console.log("Silence after speech – auto-stopping mic and sending");
                        stoppedByCode = false;  // allow onend to auto-send
                        recognition.stop();
                    }
                }, 2000);
            }
        };

        recognition.onerror = function(event) {
            console.error("Speech Recognition Error:", event.error);
            clearTimeout(silenceTimer);
            clearTimeout(autoSendTimer);
            // "no-speech" fires when user clicks mic but says nothing – not a real error
            if (event.error === 'no-speech') {
                // onend will fire next, let it handle cleanup
                return;
            }
            if (event.error === 'aborted') {
                // recognition was programmatically aborted, not an error
                return;
            }
            isListening = false;
            micBtn.classList.remove("listening");
            input.placeholder = "> ENTER COMMAND (Shift+Enter for new line)...";
        };

        recognition.onend = function() {
            clearTimeout(silenceTimer);
            clearTimeout(autoSendTimer);
            isListening = false;
            micBtn.classList.remove("listening");
            input.placeholder = "> ENTER COMMAND (Shift+Enter for new line)...";
            
            // Only auto-send if the mic stopped naturally (user finished talking),
            // NOT when sendMessage() programmatically called recognition.stop()
            if (!stoppedByCode && wasSpoken && input.value.trim() !== "" && !sendBtn.disabled) {
                // Brief delay so the user can see the final transcription before it sends
                setTimeout(() => {
                    sendMessage();
                }, 500);
            }
        };
    } else {
        micBtn.style.display = 'none';
    }

    function toggleListening() {
        if (!recognition) return;
        if (isListening) {
            stoppedByCode = true;
            recognition.stop();
        } else {
            try {
                recognition.start();
            } catch (e) {
                // "already started" – can happen if clicked rapidly
                console.warn("Recognition start error:", e);
            }
        }
    }

    function toggleVoice() {
        voiceEnabled = !voiceEnabled;
        const btn = document.getElementById("toggleVoice");
        if (voiceEnabled) {
            btn.classList.add("active");
            btn.textContent = "[SOUND & TTS: ON]";
            playUIBeep(800, 'sine', 0.05, 0.1);
        } else {
            btn.classList.remove("active");
            btn.textContent = "[SOUND & TTS: OFF]";
            playUIBeep(300, 'square', 0.05, 0.1);
        }
    }

    function cycleVoiceMode() {
        const selector = document.getElementById('voiceSelector');
        if (voiceMode === 'friday') {
            voiceMode = 'jarvis';
            selector.className = 'voice-selector jarvis';
            selector.textContent = '[VOICE: J.A.R.V.I.S]';
            playUIBeep(500, 'triangle', 0.05, 0.15);
        } else {
            voiceMode = 'friday';
            selector.className = 'voice-selector friday';
            selector.textContent = '[VOICE: F.R.I.D.A.Y]';
            playUIBeep(900, 'sine', 0.05, 0.15);
        }
        // Sync the voice mode overlay toggle button
        if (typeof vmUpdateVoiceToggle === 'function') vmUpdateVoiceToggle();
    }

    function stopVoice() {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
            currentAudio = null;
        }
        document.getElementById('stopVoiceBtn').classList.remove('visible');
        playUIBeep(400, 'square', 0.03, 0.08);
    }

    function clearTerminal() {
        messagesHistory = [];
        messagesDiv.innerHTML = '';
        addMessage("Terminal memory wiped. Link re-established.", "bot");
        playUIBeep(500, 'triangle', 0.05, 0.2);
    }
    
    // UI Beep Generator
    function playUIBeep(frequency, type='square', volume=0.05, duration=0.1) {
        if(!voiceEnabled) return;
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if(audioCtx.state === 'suspended') audioCtx.resume();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscillator.type = type;
        oscillator.frequency.value = frequency;
        gainNode.gain.setValueAtTime(volume, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + duration);
    }

    // Auto-resize textarea
    input.addEventListener('input', function() {
        if (!isListening) wasSpoken = false;
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
        if(this.value === '') {
            this.style.height = '52px';
        }
    });

    // Enter key to send message seamlessly
    input.addEventListener("keydown", function(event) {
        if(event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    function showLoading() {
        loadingIndicator.style.display = "flex";
        sendBtn.disabled = true;
    }

    function hideLoading() {
        loadingIndicator.style.display = "none";
        sendBtn.disabled = false;
        input.focus();
    }

    async function sendMessage() {
        if (isListening && recognition) {
            stoppedByCode = true;  // prevent onend from calling sendMessage again
            recognition.stop();
        }
        
        const text = input.value.trim();
        if(text === "") return;

        // ─── VOICE PROTOCOL ACTIVATION ───
        if (text.toUpperCase() === 'INITIATE VOICE PROTOCOL') {
            input.value = '';
            input.style.height = '52px';
            enterVoiceMode();
            return;
        }

        const currentSpoken = wasSpoken;
        wasSpoken = false; // Reset for next message

        addMessage(text, "user");
        messagesHistory.push({"role": "user", "content": text});
        playUIBeep(1200, 'sine', 0.02, 0.05); // Input beep
        
        input.value = "";
        input.style.height = '52px';
        showLoading();
        messagesDiv.scrollTop = messagesDiv.scrollHeight;

        try {
            const response = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messages: messagesHistory, use_tts: currentSpoken, voice_mode: voiceMode, model: currentModel })
            });

            const data = await response.json();
            hideLoading();

            if(data.response) {
                addMessage(data.response, "bot");
                messagesHistory.push({"role": "assistant", "content": data.response});
                playUIBeep(600, 'sawtooth', 0.02, 0.1); // Receive beep
                
                // Keep history manageable (last 20 messages)
                if (messagesHistory.length > 20) {
                    messagesHistory = messagesHistory.slice(messagesHistory.length - 20);
                }

                // Play Audio Response if enabled
                if (data.audio && voiceEnabled) {
                    try {
                        // Stop any currently playing audio first
                        if (currentAudio) {
                            currentAudio.pause();
                            currentAudio = null;
                        }
                        const snd = new Audio('data:audio/mp3;base64,' + data.audio);
                        currentAudio = snd;
                        const stopBtn = document.getElementById('stopVoiceBtn');
                        stopBtn.classList.add('visible');
                        snd.addEventListener('ended', () => {
                            currentAudio = null;
                            stopBtn.classList.remove('visible');
                        });
                        snd.play();
                    } catch(e) { console.error("Audio playback failed", e); }
                }
            } else {
                addMessage("**SYSTEM ERROR:** No payload received from mainframe.", "bot");
            }

        } catch(error) {
            hideLoading();
            addMessage("**CRITICAL CONNECTION FAILURE.** Network offline.", "bot");
        }
    }

    async function typeHtmlWithGlitch(htmlString, targetElement) {
        targetElement.innerHTML = '';
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlString;
        
        async function processNode(node, currentTarget) {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.nodeValue;
                for (let i = 0; i < text.length; i++) {
                    const char = text[i];
                    if (char === '\n' || char === '\r' || char === '\t' || char === ' ') {
                        currentTarget.appendChild(document.createTextNode(char));
                    } else {
                        const span = document.createElement("span");
                        span.className = "letter";
                        span.textContent = char;
                        currentTarget.appendChild(span);
                    }
                    if (i % 3 === 0) {
                        messagesDiv.scrollTop = messagesDiv.scrollHeight;
                    }
                    await new Promise(r => setTimeout(r, 6)); // super fast typing
                }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const clonedNode = node.cloneNode(false);
                currentTarget.appendChild(clonedNode);
                for (let child of node.childNodes) {
                    await processNode(child, clonedNode);
                }
            }
        }

        for (let child of tempDiv.childNodes) {
            await processNode(child, targetElement);
        }
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function addMessage(text, sender) {
        const group = document.createElement('div');
        group.className = 'message-group ' + sender + (sender === 'bot' ? ' bot-anim' : '');

        const labelDiv = document.createElement('div');
        labelDiv.className = 'message-label';
        labelDiv.textContent = sender === "user" ? 'OPERATOR' : 'M.I.T.H.R.A';

        const content = document.createElement('div');
        content.className = 'message-content';

        group.appendChild(labelDiv);
        group.appendChild(content);
        messagesDiv.appendChild(group);

        if(sender === "bot") {
            // Render Markdown
            const rawHtml = marked.parse(text);
            const cleanHtml = DOMPurify.sanitize(rawHtml);
            
            // Start the glitch typing effect
            typeHtmlWithGlitch(cleanHtml, content).then(() => {
                processCodeBlocks(content);
                // Trigger Highlight.js on all newly typed code blocks
                content.querySelectorAll('pre code').forEach((block) => {
                    hljs.highlightElement(block);
                });
            });
        } else {
            // Escape user input to prevent XSS manually, or just use textContent
            const tempDiv = document.createElement('div');
            tempDiv.textContent = text;
            content.innerHTML = `<p>${tempDiv.innerHTML.replace(/\\n/g, '<br>')}</p>`;
        }

        messagesDiv.scrollTop = messagesDiv.scrollHeight;
        
        // Ensure scrolling follows image/content load if any
        setTimeout(() => {
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }, 100);
    }

    function processCodeBlocks(container) {
        const preElements = container.querySelectorAll('pre');
        
        preElements.forEach(pre => {
            // Create wrapper
            const wrapper = document.createElement('div');
            wrapper.className = 'code-wrapper';
            
            // Extract language if present
            const codeEl = pre.querySelector('code');
            let lang = 'CODE';
            if (codeEl && codeEl.className) {
                const match = codeEl.className.match(/language-(\\w+)/);
                if (match) lang = match[1].toUpperCase();
            }

            // Create header
            const header = document.createElement('div');
            header.className = 'code-header';
            
            const langLabel = document.createElement('span');
            langLabel.textContent = lang;
            
            const copyBtn = document.createElement('button');
            copyBtn.className = 'copy-btn';
            copyBtn.textContent = 'EXTRACT';
            
            copyBtn.addEventListener('click', () => {
                const codeText = codeEl.innerText;
                navigator.clipboard.writeText(codeText).then(() => {
                    copyBtn.textContent = 'COPIED!';
                    copyBtn.style.color = '#00ff00';
                    setTimeout(() => {
                        copyBtn.textContent = 'EXTRACT';
                        copyBtn.style.color = '';
                    }, 2000);
                });
            });

            header.appendChild(langLabel);
            header.appendChild(copyBtn);
            
            // Insert into DOM
            pre.parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(header);
            wrapper.appendChild(pre);
        });
    }

    // Initial Welcome Message
    window.onload = () => {
        // Fetch available models on startup
        fetchModels();
        setTimeout(() => {
            addMessage("Neural interface synchronized. Awaiting input... Type \"INITIATE VOICE PROTOCOL\" for full voice mode. Use the model selector above to switch engines.", "bot");
        }, 800);
    };

    // ═══════════════════════════════════════════════════════
    //  VOICE PROTOCOL MODE — FULL CONVERSATION ENGINE
    // ═══════════════════════════════════════════════════════
    let vmActive = false;
    let vmRecognition = null;       // separate recognition instance for voice mode
    let vmIsListening = false;
    let vmCurrentAudio = null;
    let vmSilenceTimer = null;
    let vmAutoSendTimer = null;
    let vmIsProcessing = false;

    // DOM references for voice mode
    const vmOverlay = document.getElementById('voiceModeOverlay');
    const vmAvatarContainer = document.getElementById('vmAvatarContainer');
    const vmWaveform = document.getElementById('vmWaveform');
    const vmSubtitleLabel = document.getElementById('vmSubtitleLabel');
    const vmSubtitleText = document.getElementById('vmSubtitleText');
    const vmMicBtn = document.getElementById('vmMicBtn');
    const vmProcessing = document.getElementById('vmProcessing');
    const vmVoiceToggle = document.getElementById('vmVoiceToggle');

    function enterVoiceMode() {
        vmActive = true;
        vmOverlay.style.display = 'flex';
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                vmOverlay.classList.add('active');
            });
        });
        vmSubtitleText.textContent = 'Voice protocol initialized. Speak to begin...';
        vmSubtitleLabel.textContent = 'M.I.T.H.R.A';
        vmSubtitleLabel.classList.remove('user-label');
        vmAvatarContainer.className = 'hud-avatar-system';
        vmWaveform.className = 'hud-waveform';
        vmUpdateVoiceToggle();
        
        // Sync HUD Data Panels
        document.getElementById('vmModelName').textContent = currentModel.toUpperCase().substring(0, 10);
        document.getElementById('vmModelSelector').value = currentModel;

        playUIBeep(600, 'sine', 0.06, 0.2);
        addMessage("Voice protocol activated. Switching to neural voice interface...", "bot");
        setTimeout(() => { vmStartListening(); }, 1500);
    }

    function exitVoiceMode() {
        vmActive = false;
        vmStopListening();
        vmStopAudio();
        vmOverlay.classList.remove('active');
        setTimeout(() => { vmOverlay.style.display = 'none'; }, 600);
        playUIBeep(300, 'square', 0.05, 0.15);
        addMessage("Voice protocol terminated. Returning to text interface.", "bot");
    }

    function vmUpdateVoiceToggle() {
        if (vmVoiceToggle) {
            vmVoiceToggle.textContent = voiceMode === 'friday' ? 'F.R.I.D.A.Y' : 'J.A.R.V.I.S';
        }
        document.getElementById('vmVoiceInfo').textContent = voiceMode === 'friday' ? 'FRIDAY' : 'JARVIS';
    }

    // ─── VOICE MODE SPEECH RECOGNITION ───
    function vmSetupRecognition() {
        if (!SpeechRecognition) return;
        if (vmRecognition) return;

        vmRecognition = new SpeechRecognition();
        vmRecognition.continuous = true;
        vmRecognition.interimResults = true;
        vmRecognition.lang = 'en-US';
        vmRecognition.maxAlternatives = 1;

        vmRecognition.onstart = function() {
            vmIsListening = true;
            vmMicBtn.classList.add('active');
            vmAvatarContainer.className = 'hud-avatar-system user-speaking';
            vmWaveform.className = 'hud-waveform user-active';
            vmSubtitleLabel.textContent = 'OPERATOR';
            vmSubtitleLabel.classList.add('user-label');
            vmSubtitleText.innerHTML = '<span class="vm-interim">Listening...</span>';
            document.getElementById('vmSpeechStatus').textContent = 'LISTENING';
            clearTimeout(vmSilenceTimer);
            vmSilenceTimer = setTimeout(() => {
                if (vmIsListening && vmRecognition) vmRecognition.stop();
            }, 60000);
        };

        vmRecognition.onresult = function(event) {
            clearTimeout(vmAutoSendTimer);
            let finalText = '';
            let interimText = '';
            for (let i = 0; i < event.results.length; ++i) {
                if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
                else interimText += event.results[i][0].transcript;
            }
            let display = '';
            if (finalText) display += finalText;
            if (interimText) display += '<span class="vm-interim">' + interimText + '</span>';
            vmSubtitleText.innerHTML = display || '<span class="vm-interim">Listening...</span>';

            if (finalText.trim() !== '') {
                vmAutoSendTimer = setTimeout(() => {
                    if (vmIsListening && vmRecognition) vmRecognition.stop();
                }, 1500);
            }
        };

        vmRecognition.onerror = function(event) {
            clearTimeout(vmSilenceTimer);
            clearTimeout(vmAutoSendTimer);
            if (event.error === 'no-speech' || event.error === 'aborted') return;
            vmIsListening = false;
            vmMicBtn.classList.remove('active');
            vmAvatarContainer.className = 'hud-avatar-system';
            vmWaveform.className = 'hud-waveform';
            document.getElementById('vmSpeechStatus').textContent = 'ERROR';
        };

        vmRecognition.onend = function() {
            clearTimeout(vmSilenceTimer);
            clearTimeout(vmAutoSendTimer);
            vmIsListening = false;
            vmMicBtn.classList.remove('active');
            vmWaveform.className = 'hud-waveform';
            document.getElementById('vmSpeechStatus').textContent = 'READY';

            const spokenText = vmSubtitleText.textContent.trim();

            if (spokenText && spokenText !== 'Listening...' && vmActive) {
                if (spokenText.toUpperCase().includes('EXIT VOICE') || spokenText.toUpperCase().includes('TERMINATE PROTOCOL')) {
                    exitVoiceMode();
                    return;
                }
                vmSendMessage(spokenText);
            } else {
                vmAvatarContainer.className = 'hud-avatar-system';
            }
        };
    }

    function vmStartListening() {
        if (!vmActive) return;
        vmSetupRecognition();
        if (!vmRecognition) return;
        if (vmIsListening) return;
        try { vmRecognition.start(); } catch(e) { }
    }

    function vmStopListening() {
        if (vmRecognition && vmIsListening) {
            try { vmRecognition.stop(); } catch(e) {}
        }
        vmIsListening = false;
        vmMicBtn.classList.remove('active');
    }

    function vmToggleMic() {
        if (vmIsListening) {
            vmStopListening();
            vmAvatarContainer.className = 'hud-avatar-system';
            vmWaveform.className = 'hud-waveform';
            vmSubtitleText.textContent = 'Microphone paused. Click mic to resume.';
            document.getElementById('vmSpeechStatus').textContent = 'PAUSED';
        } else {
            vmStartListening();
        }
    }

    function vmStopAudio() {
        if (vmCurrentAudio) {
            vmCurrentAudio.pause();
            vmCurrentAudio.currentTime = 0;
            vmCurrentAudio = null;
        }
        vmAvatarContainer.className = 'hud-avatar-system';
        vmWaveform.className = 'hud-waveform';
        vmSubtitleLabel.textContent = 'M.I.T.H.R.A';
        vmSubtitleLabel.classList.remove('user-label');
        if (vmActive) setTimeout(() => vmStartListening(), 500);
    }

    // Handle Model Selection Sync in Voice Mode
    if (document.getElementById('vmModelSelector')) {
        document.getElementById('vmModelSelector').addEventListener('change', (e) => {
            currentModel = e.target.value;
            if (document.getElementById('modelSelector')) {
                document.getElementById('modelSelector').value = currentModel;
            }
            if (document.getElementById('vmModelName')) {
                document.getElementById('vmModelName').textContent = currentModel.toUpperCase().substring(0, 10);
            }
        });
    }

    // Wrap the existing model selection functionality in checks
    const mainModelSelector = document.getElementById('modelSelector');
    if (mainModelSelector) {
        mainModelSelector.addEventListener('change', (e) => {
            const vmSelector = document.getElementById('vmModelSelector');
            if (vmSelector) vmSelector.value = e.target.value;
            const vmModelName = document.getElementById('vmModelName');
            if (vmModelName) vmModelName.textContent = e.target.value.toUpperCase().substring(0, 10);
        });
    }

    // ─── VOICE MODE MESSAGE SEND (STREAMING) ───
    async function vmSendMessage(text) {
        if(!text.trim() || !vmActive || vmIsProcessing) return;
        vmIsProcessing = true;
        vmAvatarContainer.className = 'hud-avatar-system processing';
        vmWaveform.className = 'hud-waveform';
        vmSubtitleLabel.textContent = 'OPERATOR';
        vmSubtitleLabel.classList.add('user-label');
        vmSubtitleText.textContent = text;
        vmProcessing.classList.add('active');
        vmMicBtn.classList.add('disabled');
        document.getElementById('vmEngineStatus').textContent = 'COMPUTING';

        messagesHistory.push({"role": "user", "content": text});
        addMessage(text, 'user');
        
        let aiResponse = "";
        vmSubtitleLabel.textContent = 'M.I.T.H.R.A';
        vmSubtitleLabel.classList.remove('user-label');
        vmSubtitleText.textContent = "";

        let tokenCount = 0;
        const startTime = Date.now();

        let audioQueue = [];
        let isPlaying = false;
        let processedCleanLength = 0;

        async function fetchChunkTTS(textChunk) {
            try {
                const res = await fetch("/api/tts", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: textChunk, voice_mode: voiceMode })
                });
                const data = await res.json();
                if (data.audio) {
                    audioQueue.push({ base64: data.audio, text: textChunk });
                    playNextAudio();
                }
            } catch (e) { console.error("Chunk TTS error", e); }
        }

        function playNextAudio() {
            if (isPlaying || audioQueue.length === 0 || !vmActive) return;
            isPlaying = true;
            
            const nextChunk = audioQueue.shift();
            vmAvatarContainer.className = 'hud-avatar-system speaking';
            vmWaveform.className = 'hud-waveform active';
            vmSubtitleText.textContent = nextChunk.text.trim();
            document.getElementById('vmEngineStatus').textContent = 'VOCODER';
            
            const snd = new Audio('data:audio/mp3;base64,' + nextChunk.base64);
            vmCurrentAudio = snd;
            
            snd.addEventListener('ended', () => {
                vmCurrentAudio = null;
                isPlaying = false;
                if (audioQueue.length > 0) {
                    playNextAudio();
                } else if (!vmProcessing.classList.contains('active')) {
                    vmAvatarContainer.className = 'hud-avatar-system';
                    vmWaveform.className = 'hud-waveform';
                    document.getElementById('vmEngineStatus').textContent = 'ONLINE';
                    if (vmActive) setTimeout(() => vmStartListening(), 800);
                } else {
                    vmAvatarContainer.className = 'hud-avatar-system processing';
                    vmWaveform.className = 'hud-waveform';
                    vmSubtitleText.textContent = "Processing further analysis...";
                    document.getElementById('vmEngineStatus').textContent = 'COMPUTING';
                }
            });
            
            snd.addEventListener('error', () => {
                isPlaying = false;
                playNextAudio();
            });
            
            snd.play().catch(e => {
                console.error("Autoplay bypass:", e);
                vmSubtitleText.textContent = '(Audio blocked by browser. Click screen to resume.)';
                isPlaying = false;
                const unlockAudio = () => {
                    document.removeEventListener('click', unlockAudio);
                    if (vmActive) vmStartListening();
                };
                document.addEventListener('click', unlockAudio);
            });
        }

        try {
            const response = await fetch("/api/chat/stream", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messages: messagesHistory, model: currentModel })
            });

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");

            while(true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const chunk = decoder.decode(value);
                const lines = chunk.split('\n\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.substring(6);
                        try {
                            const data = JSON.parse(dataStr);
                            if (data.error) break;

                            if (data.token) {
                                aiResponse += data.token;
                                tokenCount++;
                                
                                document.getElementById('vmTokenCount').textContent = tokenCount;
                                document.getElementById('vmLatency').textContent = (Date.now() - startTime) + 'ms';

                                if (!isPlaying && audioQueue.length === 0) {
                                    const dots = ".".repeat(Math.floor(tokenCount / 4) % 4);
                                    vmSubtitleText.textContent = "Processing " + dots;
                                }

                                let cleanTemp = aiResponse.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').replace(/[\*#`]/g, '');
                                if (cleanTemp.length > processedCleanLength) {
                                    let unprocessed = cleanTemp.substring(processedCleanLength);
                                    let match = unprocessed.match(/^([\s\S]*?[.!?\n]+(?:\s|$))/);
                                    if (match) {
                                        let sentence = match[1];
                                        processedCleanLength += sentence.length;
                                        if (sentence.trim().length > 0) {
                                            fetchChunkTTS(sentence.trim());
                                        }
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                }
            }
            
            vmProcessing.classList.remove('active');
            
            if (aiResponse) {
                messagesHistory.push({"role": "assistant", "content": aiResponse});
                addMessage(aiResponse, 'bot');
                if (messagesHistory.length > 20) messagesHistory = messagesHistory.slice(messagesHistory.length - 20);

                let cleanFinal = aiResponse.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').replace(/[\*#`]/g, '');
                let remainder = cleanFinal.substring(processedCleanLength).trim();
                if (remainder) {
                    await fetchChunkTTS(remainder);
                }

                if (audioQueue.length === 0 && !isPlaying) {
                    vmSubtitleText.textContent = remainder || '(Analysis Complete)';
                    vmAvatarContainer.className = 'hud-avatar-system';
                    document.getElementById('vmEngineStatus').textContent = 'ONLINE';
                    if (vmActive) setTimeout(() => vmStartListening(), 1500);
                }
            } else {
                vmSubtitleText.textContent = 'Error: No response received.';
                document.getElementById('vmEngineStatus').textContent = 'ERROR';
                if (vmActive) setTimeout(() => vmStartListening(), 2000);
            }
        } catch(error) {
            console.error(error);
            vmProcessing.classList.remove('active');
            vmSubtitleText.textContent = 'Connection error. Retrying...';
            document.getElementById('vmEngineStatus').textContent = 'ERROR';
            if (vmActive) setTimeout(() => vmStartListening(), 2000);
        }
        vmMicBtn.classList.remove('disabled');
        vmIsProcessing = false;
    }
