import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface TriageResult {
  severity: 'critical' | 'high' | 'medium' | 'low';
  steps: string[];
  specialist: string;
  callEmergency: boolean;
  disclaimer: string;
}

export interface HospitalData {
  name: string;
  address: string;
  phone: string;
  lat: number;
  lng: number;
  mapsUri?: string;
}

export async function runTriage(symptoms: string, language: string = 'English'): Promise<TriageResult> {
  const model = "gemini-3-flash-preview";
  
  const response = await ai.models.generateContent({
    model,
    contents: `Emergency: ${symptoms}`,
    config: {
      systemInstruction: `You are LifeAidX — a medically-constrained emergency triage assistant for India. ALWAYS recommend calling 112 or 108 first for serious emergencies. Give calm, clear, actionable instructions.
Respond in ${language} language.
Severity: critical=life-threatening; high=hospital within 1hr; medium=today; low=manageable at home.
Provide 4-7 actionable steps, most critical first.`,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          severity: {
            type: Type.STRING,
            description: "The severity level: critical, high, medium, or low.",
          },
          steps: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Actionable first aid steps.",
          },
          specialist: {
            type: Type.STRING,
            description: "The type of medical specialist to see.",
          },
          callEmergency: {
            type: Type.BOOLEAN,
            description: "Whether to call emergency services immediately.",
          },
          disclaimer: {
            type: Type.STRING,
            description: "A brief medical disclaimer.",
          },
        },
        required: ["severity", "steps", "specialist", "callEmergency", "disclaimer"],
      },
    },
  });

  const text = response.text;
  if (!text) throw new Error("No response from AI");
  return JSON.parse(text) as TriageResult;
}

export async function searchHospitals(lat: number, lng: number): Promise<HospitalData[]> {
  const model = "gemini-2.5-flash";
  
  const response = await ai.models.generateContent({
    model,
    contents: `Find 5 major hospitals strictly near latitude ${lat}, longitude ${lng}. 
    This is for an emergency accident response at these EXACT coordinates.
    For each hospital, provide:
    1. Full Name
    2. Complete Address
    3. Emergency Phone Number (or main line)
    4. Approximate Latitude and Longitude
    
    Ensure the hospitals are sorted by proximity to the provided coordinates.
    Format the output as a valid JSON array of objects with keys: "name", "address", "phone", "lat", "lng". 
    Do not include any other text before or after the JSON.`,
    config: {
      tools: [{ googleMaps: {} }],
      toolConfig: {
        retrievalConfig: {
          latLng: { latitude: lat, longitude: lng }
        }
      }
    }
  });

  const text = response.text;
  if (!text) throw new Error("No response from hospital search");

  // Extract JSON from the response text
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn("Could not find JSON in response:", text);
    throw new Error("Invalid response format from hospital search");
  }

  try {
    const hospitals = JSON.parse(jsonMatch[0]) as HospitalData[];
    
    // Add mapsUri from grounding chunks if available
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (chunks) {
      hospitals.forEach((h, i) => {
        const chunk = chunks.find((c: any) => c.maps?.title?.toLowerCase().includes(h.name.toLowerCase()));
        if (chunk) {
          h.mapsUri = chunk.maps.uri;
        }
      });
    }
    
    return hospitals;
  } catch (e) {
    console.error("Failed to parse hospital JSON", e);
    throw new Error("Failed to process hospital data");
  }
}
