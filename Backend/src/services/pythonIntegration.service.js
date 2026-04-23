const callPythonModule = async (dataPayload) => {
    try {
        const response = await fetch('http://localhost:8000/api/python-module/process', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json', // Tell Python you are sending JSON
            },
            body: JSON.stringify(dataPayload) // Convert your Node object to a JSON string
        });

        // Fetch doesn't throw an error on 400/500 status codes automatically, so we check it here
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const data = await response.json(); // Parse the JSON response from Python
        return data;
        
    } catch (error) {
        console.error("Error communicating with Python service:", error);
        throw error;
    }
};

module.exports = { callPythonModule };