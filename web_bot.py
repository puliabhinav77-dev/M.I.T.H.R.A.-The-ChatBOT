from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context
import requests
import os
import asyncio
import threading
import edge_tts
import tempfile
import base64
import re
import json
import traceback

app = Flask(__name__)

# Persistent event loop in a background thread so asyncio.run() isn't needed
_loop = asyncio.new_event_loop()
def _start_loop(loop):
    asyncio.set_event_loop(loop)
    loop.run_forever()
_thread = threading.Thread(target=_start_loop, args=(_loop,), daemon=True)
_thread.start()

def run_async(coro):
    """Run an async coroutine on the persistent event loop and return the result."""
    future = asyncio.run_coroutine_threadsafe(coro, _loop)
    return future.result(timeout=120)

def remove_markdown(text):
    text = re.sub(r'<think>.*?(?:</think>|$)', '', text, flags=re.DOTALL)
    text = re.sub(r'\*\*(.*?)\*\*', r'\1', text)
    text = re.sub(r'\*(.*?)\*', r'\1', text)
    text = re.sub(r'```.*?```', r'code block', text, flags=re.DOTALL)
    text = re.sub(r'`(.*?)`', r'\1', text)
    text = re.sub(r'#(.*?)\n', r'\n', text)
    text = text.replace('*', '')  # Safety net for unmatched asterisks
    return text.strip()

# Voice profiles – tuned to sound like MCU AI assistants
VOICE_PROFILES = {
    'friday': {
        'voice': 'en-US-JennyNeural',      # Clean, professional female
        'rate': '+8%',                       # Slightly faster – crisp AI delivery
        'pitch': '+0Hz',                     # Natural pitch
    },
    'jarvis': {
        'voice': 'en-GB-RyanNeural',        # Sophisticated British male
        'rate': '-5%',                       # Measured, deliberate pace
        'pitch': '-3Hz',                     # Slightly deeper for gravitas
    },
}

async def generate_tts(text, voice_mode='friday'):
    clean_text = remove_markdown(text)
    profile = VOICE_PROFILES.get(voice_mode, VOICE_PROFILES['friday'])
    communicate = edge_tts.Communicate(
        clean_text,
        profile['voice'],
        rate=profile['rate'],
        pitch=profile['pitch'],
    )
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tf:
        tmp_path = tf.name
    await communicate.save(tmp_path)
    with open(tmp_path, "rb") as f:
        audio_data = f.read()
    os.remove(tmp_path)
    return base64.b64encode(audio_data).decode('utf-8')

@app.route('/')
def home():
    with open('index.html', 'r', encoding='utf-8') as f:
        return f.read()

@app.route('/assets/<path:filename>')
def serve_assets(filename):
    return send_from_directory('assets', filename)

@app.route('/api/models', methods=['GET'])
def get_models():
    """Fetches installed model list from Ollama."""
    try:
        response = requests.get('http://localhost:11434/api/tags', timeout=10)
        if response.status_code == 200:
            data = response.json()
            models = []
            for m in data.get('models', []):
                models.append({
                    'name': m.get('name', ''),
                    'size': m.get('size', 0),
                    'modified_at': m.get('modified_at', ''),
                })
            return jsonify({'models': models})
        else:
            return jsonify({'error': 'Failed to fetch models from Ollama'}), 500
    except Exception as e:
        print("MODELS ENDPOINT ERROR:", e)
        return jsonify({'error': str(e)}), 500

@app.route('/api/chat/stream', methods=['POST'])
def chat_stream():
    """Streaming chat endpoint using Server-Sent Events for real-time token delivery."""
    data = request.json
    messages = data.get('messages', [])
    model = data.get('model', 'mistral')

    def generate():
        try:
            response = requests.post(
                'http://localhost:11434/api/chat',
                json={'model': model, 'messages': messages, 'stream': True},
                stream=True,
                timeout=300
            )
            for line in response.iter_lines():
                if line:
                    chunk = json.loads(line.decode())
                    token = chunk.get('message', {}).get('content', '')
                    done = chunk.get('done', False)
                    yield f"data: {json.dumps({'token': token, 'done': done})}\n\n"
                    if done:
                        break
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive'
        }
    )

@app.route('/api/tts', methods=['POST'])
def tts_endpoint():
    """Standalone TTS endpoint – call after streaming to generate audio."""
    try:
        data = request.json
        text = data.get('text', '')
        voice_mode = data.get('voice_mode', 'friday')
        if not text.strip():
            return jsonify({'error': 'No text provided'}), 400
        audio_b64 = run_async(generate_tts(text, voice_mode))
        return jsonify({'audio': audio_b64})
    except Exception as e:
        print("TTS ENDPOINT ERROR:", e)
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/chat', methods=['POST'])
def chat():
    try:
        data = request.json
        user_message = data.get('message')
        messages = data.get('messages')
        use_tts = data.get('use_tts', False)
        voice_mode = data.get('voice_mode', 'friday')
        model = data.get('model', 'mistral')
        
        if not messages:
            if user_message:
                messages = [{'role': 'user', 'content': user_message}]
            else:
                return jsonify({"error": "No messages"}), 400
        
        response = requests.post(
            'http://localhost:11434/api/chat',
            json={
                'model': model,
                'messages': messages,
                'stream': False
            },
            timeout=300
        )
        
        if response.status_code == 200:
            result = response.json()
            bot_message = result.get('message', {}).get('content', 'No response')
            audio_b64 = None
            if use_tts:
                try:
                    audio_b64 = run_async(generate_tts(bot_message, voice_mode))
                except Exception as e:
                    print("TTS Error:", e)
                    traceback.print_exc()

            return jsonify({'response': bot_message, 'audio': audio_b64})
        else:
            return jsonify({'error': 'Ollama error'}), 500
    
    except Exception as e:
        print("CHAT ENDPOINT ERROR:", e)
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    print("=" * 60)
    print("M.I.T.H.R.A CYBERPUNK OS INITIALIZING...")
    print("Open your browser and go to: http://localhost:5000")
    print("=" * 60)
    app.run(debug=False, port=5000)