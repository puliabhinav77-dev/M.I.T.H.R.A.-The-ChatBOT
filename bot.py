import requests

def chat_with_bot(user_message):
    response = requests.post(
        "http://localhost:11434/api/chat",
        json={
            "model": "mistral",
            "messages": [{"role": "user", "content": user_message}],
            "stream": False
        }
    )
    
    if response.status_code == 200:
        return response.json()["message"]["content"]
    else:
        return "Error: Cannot connect to Ollama"

print("Offline AI Chatbot (type 'exit' to quit)\n")

while True:
    user_input = input("You: ")
    
    if user_input.lower() == "exit":
        print("Goodbye!")
        break
    
    response = chat_with_bot(user_input)
    print(f"Bot: {response}\n")