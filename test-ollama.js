import  ollama  from 'ollama';

async function testConnection() {
  try {
    console.log("🔄 Connecting to local Ollama server...");
    
    const response = await ollama.chat({
      model: 'llama3.1', // Change to 'qwen2.5' if using that model
      messages: [{ role: 'user', content: 'Respond with the word "Connected" if you can read this.' }],
    });

    console.log(`✅ Success! Response from AI: ${response.message.content.trim()}`);
  } catch (error) {
    console.error("❌ Connection Failed!");
    console.error("Make sure the Ollama desktop app is running on port 11434.");
    console.error("Details:", error.message);
  }
}

testConnection();
