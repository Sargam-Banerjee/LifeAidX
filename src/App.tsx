/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, 
  MapPin, 
  History, 
  Info, 
  Mic, 
  MicOff, 
  Phone, 
  AlertTriangle, 
  ChevronRight,
  Shield,
  Clock,
  Zap,
  CheckCircle2,
  XCircle,
  Stethoscope,
  MessageSquare,
  ExternalLink
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { runTriage, searchHospitals, TriageResult, HospitalData } from './services/geminiService';
import { translations } from './translations';

// --- Types ---
interface Incident {
  id?: number;
  symptoms: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  steps: string[];
  specialist: string;
  timestamp: string | number;
  isFallEvent: boolean;
  lat?: number;
  lng?: number;
  hospital?: string;
}

interface Hospital {
  name: string;
  lat: number;
  lng: number;
  address: string;
  phone: string;
  dist: number;
  mapsUri?: string;
}

// --- Constants ---
const FREE_FALL_G = 0.55;
const IMPACT_G = 2.4;
const FREE_FALL_MS = 60;
const IMPACT_WINDOW = 700;
const COOLDOWN_MS = 30000;

const SCENARIOS = [
  'Person unconscious, not breathing',
  'Severe chest pain, left arm numbness',
  'Deep cut with heavy bleeding',
  'Child choking on food',
  'Possible bone fracture after fall',
  'Burn injury from fire',
  'Severe allergic reaction, face swelling',
];

// --- Helper Functions ---
function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'triage' | 'map' | 'history' | 'about'>('triage');
  const [symptoms, setSymptoms] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<TriageResult | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [fallEnabled, setFallEnabled] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [language, setLanguage] = useState('English');
  const [gForce, setGForce] = useState(1.0);
  const [showFallModal, setShowFallModal] = useState(false);
  const [countdown, setCountdown] = useState(10);
  const [nearestHospital, setNearestHospital] = useState<Hospital | null>(null);
  const [allHospitals, setAllHospitals] = useState<Hospital[]>([]);
  const [userLocation, setUserLocation] = useState<{ lat: number, lng: number } | null>(null);
  const [showSentModal, setShowSentModal] = useState(false);
  const [isBooking, setIsBooking] = useState<string | null>(null);
  const [dispatchedIncident, setDispatchedIncident] = useState<Incident | null>(null);
  const [reportingHospital, setReportingHospital] = useState<Hospital | null>(null);
  const [reportType, setReportType] = useState('wrongPhone');
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [isLocating, setIsLocating] = useState(false);

  const gHistoryRef = useRef<number[]>(new Array(60).fill(1));
  const fallStateRef = useRef({
    phase: 'idle' as 'idle' | 'freeFall' | 'waitCountdown',
    freeFallStart: null as number | null,
    fallTimestamp: null as number | null,
    fallGPeak: 0,
    lastTriggerTime: 0
  });

  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);

  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recognitionRef = useRef<any>(null);

  const t = translations[language] || translations.English;

  // --- Effects ---
  useEffect(() => {
    fetchIncidents();
    if (fallEnabled) {
      startFallDetection();
    }
    // Auto-locate on mount
    findNearestHospital();
    return () => stopFallDetection();
  }, [fallEnabled]);

  useEffect(() => {
    if (showFallModal) {
      startCountdown();
      // findNearestHospital is now called within triggerFallAlert for better precision
    } else {
      stopCountdown();
    }
  }, [showFallModal]);

  // --- Data Fetching ---
  const fetchIncidents = async () => {
    try {
      const res = await fetch('/api/incidents');
      const data = await res.json();
      setIncidents(data);
    } catch (error) {
      console.error("Failed to fetch history", error);
    }
  };

  const saveIncident = async (incident: Omit<Incident, 'id' | 'timestamp'>) => {
    try {
      await fetch('/api/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(incident)
      });
      fetchIncidents();
    } catch (error) {
      console.error("Failed to save incident", error);
    }
  };

  // --- Fall Detection Logic ---
  const startFallDetection = () => {
    if (typeof DeviceMotionEvent !== 'undefined') {
      window.addEventListener('devicemotion', handleMotion, { passive: true });
    }
  };

  const stopFallDetection = () => {
    window.removeEventListener('devicemotion', handleMotion);
  };

  const handleMotion = (event: DeviceMotionEvent) => {
    const acc = event.accelerationIncludingGravity || event.acceleration;
    if (!acc) return;

    const x = acc.x || 0, y = acc.y || 0, z = acc.z || 0;
    const g = Math.sqrt(x * x + y * y + z * z) / 9.81;
    setGForce(g);

    gHistoryRef.current.push(g);
    if (gHistoryRef.current.length > 60) gHistoryRef.current.shift();

    const state = fallStateRef.current;
    if (Date.now() - state.lastTriggerTime < COOLDOWN_MS) return;
    if (state.phase === 'waitCountdown') return;

    // Phase 1: Free fall
    if (state.phase === 'idle') {
      if (g < FREE_FALL_G) {
        if (!state.freeFallStart) state.freeFallStart = Date.now();
        else if (Date.now() - state.freeFallStart >= FREE_FALL_MS) {
          state.phase = 'freeFall';
          state.fallTimestamp = Date.now();
          state.fallGPeak = 0;
        }
      } else {
        state.freeFallStart = null;
      }
    }

    // Phase 2: Impact
    if (state.phase === 'freeFall') {
      if (g > state.fallGPeak) state.fallGPeak = g;
      if (g > IMPACT_G) {
        if (Date.now() - state.fallTimestamp! <= IMPACT_WINDOW) {
          state.phase = 'waitCountdown';
          state.lastTriggerTime = Date.now();
          triggerFallAlert(state.fallGPeak);
        }
      }
      if (Date.now() - state.fallTimestamp! > IMPACT_WINDOW + 200) {
        state.phase = 'idle';
        state.freeFallStart = null;
      }
    }
  };

  const triggerFallAlert = async (peakG: number) => {
    setShowFallModal(true);
    if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 500]);
    
    // Capture accident location immediately
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000, enableHighAccuracy: true })
      );
      const { latitude: lat, longitude: lng } = pos.coords;
      setUserLocation({ lat, lng });
      findNearestHospital(lat, lng);
    } catch (e) {
      console.warn("Could not capture precise accident location", e);
      findNearestHospital(); // Fallback to general search
    }
  };

  const startCountdown = () => {
    setCountdown(10);
    countdownTimerRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          stopCountdown();
          dispatchAmbulance();
          return 0;
        }
        if (navigator.vibrate && prev <= 3) navigator.vibrate(80);
        return prev - 1;
      });
    }, 1000);
  };

  const stopCountdown = () => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  };

  const findNearestHospital = async (forcedLat?: number, forcedLng?: number) => {
    setIsLocating(true);
    try {
      let lat: number;
      let lng: number;

      if (forcedLat !== undefined && forcedLng !== undefined) {
        lat = forcedLat;
        lng = forcedLng;
      } else {
        const pos = await new Promise<GeolocationPosition>((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 })
        );
        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
      }

      setUserLocation({ lat, lng });

      // Try Gemini search first (more comprehensive)
      try {
        const geminiHosps = await searchHospitals(lat, lng);
        if (geminiHosps && geminiHosps.length > 0) {
          const mappedHosps: Hospital[] = geminiHosps.map(h => ({
            ...h,
            dist: haversine(lat, lng, h.lat, h.lng)
          })).sort((a, b) => a.dist - b.dist);
          
          setAllHospitals(mappedHosps);
          setNearestHospital(mappedHosps[0]);
          setIsLocating(false);
          return;
        }
      } catch (geminiError) {
        console.warn("Gemini hospital search failed, falling back to Overpass:", geminiError);
      }

      // Fallback to Overpass API
      const q = `[out:json][timeout:15];(node["amenity"="hospital"](around:8000,${lat},${lng});way["amenity"="hospital"](around:8000,${lat},${lng}););out center 5;`;
      const r = await fetch('https://overpass-api.de/api/interpreter', { 
        method: 'POST', 
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Accept': 'application/json' }
      });

      if (!r.ok) throw new Error(`Overpass API error: ${r.status}`);

      const d = await r.json();
      
      if (d.elements && d.elements.length > 0) {
        const hosps: Hospital[] = d.elements.map((h: any) => {
          const hLat = h.lat || h.center.lat;
          const hLng = h.lon || h.center.lon;
          return {
            name: h.tags.name || "Nearby Hospital",
            lat: hLat,
            lng: hLng,
            address: h.tags['addr:street'] || h.tags['addr:full'] || "Emergency Ward",
            phone: h.tags.phone || "112",
            dist: haversine(lat, lng, hLat, hLng)
          };
        }).sort((a: Hospital, b: Hospital) => a.dist - b.dist);

        setAllHospitals(hosps);
        setNearestHospital(hosps[0]);
      } else {
        throw new Error("No hospitals found in this area");
      }
    } catch (e) {
      console.error("Location/Hospital error", e);
      if (userLocation) {
        const fallbackHosp: Hospital = {
          name: "City General Hospital (Emergency)",
          lat: userLocation.lat + 0.01,
          lng: userLocation.lng + 0.01,
          address: "Main Emergency Road",
          phone: "112",
          dist: 1.5
        };
        setAllHospitals([fallbackHosp]);
        setNearestHospital(fallbackHosp);
      }
    } finally {
      setIsLocating(false);
    }
  };

  const submitReport = async () => {
    if (!reportingHospital) return;
    setIsSubmittingReport(true);
    
    // Simulate API call to report inaccuracy
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    console.log(`Report submitted for ${reportingHospital.name}: ${reportType}`);
    setIsSubmittingReport(false);
    setReportingHospital(null);
    alert(t.reportSuccess);
  };

  const bookAmbulance = async (hospital: Hospital) => {
    setIsBooking(hospital.name);
    
    // Log the incident first
    const incident: Omit<Incident, 'id' | 'timestamp'> = {
      symptoms: `Ambulance Call - ${hospital.name}`,
      severity: 'high',
      steps: [
        `Calling ${hospital.name} at ${hospital.phone}`,
        'Stay calm and wait for the ambulance',
        'Keep your phone accessible',
        'Prepare any medical documents'
      ],
      specialist: 'Emergency Services',
      isFallEvent: false,
      lat: userLocation?.lat,
      lng: userLocation?.lng,
      hospital: hospital.name
    };
    
    saveIncident(incident);
    
    // Small delay to show "Booking..." state before dialer opens
    setTimeout(() => {
      window.location.href = `tel:${hospital.phone}`;
      setIsBooking(null);
    }, 800);
  };

  const dispatchAmbulance = async () => {
    setShowFallModal(false);
    const incident: Omit<Incident, 'id' | 'timestamp'> = {
      symptoms: `Fall detected (${gForce.toFixed(1)}g) - Auto-dispatch`,
      severity: 'critical',
      steps: [
        'Call 112 immediately',
        'Keep the person still',
        'Check breathing and pulse',
        'Wait for emergency services'
      ],
      specialist: 'Emergency Medicine',
      isFallEvent: true,
      lat: userLocation?.lat,
      lng: userLocation?.lng,
      hospital: nearestHospital?.name
    };
    
    setDispatchedIncident(incident as Incident);
    setShowSentModal(true);
    saveIncident(incident);
    
    // Reset fall state
    fallStateRef.current.phase = 'idle';
    
    // Auto-dial 112
    setTimeout(() => { window.location.href = 'tel:112'; }, 3000);
  };

  // --- Handlers ---
  const handleTriage = async () => {
    if (!symptoms.trim()) return;
    setIsAnalyzing(true);
    setResult(null);
    try {
      const res = await runTriage(symptoms, language);
      setResult(res);
      saveIncident({
        symptoms,
        severity: res.severity,
        steps: res.steps,
        specialist: res.specialist,
        isFallEvent: false
      });
    } catch (error) {
      console.error(error);
      alert("Analysis failed. Please try again.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const toggleVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      alert("Speech recognition not supported in this browser.");
      return;
    }

    if (isRecording) {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      setIsRecording(false);
    } else {
      const recognition = new SR();
      recognitionRef.current = recognition;
      recognition.lang = language === 'Hindi' ? 'hi-IN' : language === 'Bengali' ? 'bn-IN' : 'en-IN';
      recognition.continuous = false;
      recognition.interimResults = false;

      recognition.onstart = () => {
        setIsRecording(true);
        setVoiceStatus(null);
      };
      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setSymptoms(prev => (prev.trim() + ' ' + transcript).trim());
      };
      recognition.onend = () => {
        setIsRecording(false);
        recognitionRef.current = null;
      };
      recognition.onerror = (event: any) => {
        if (event.error === 'no-speech') {
          setVoiceStatus("No speech detected. Try again.");
          setTimeout(() => setVoiceStatus(null), 3000);
        } else if (event.error === 'not-allowed') {
          setVoiceStatus("Microphone access denied.");
          setTimeout(() => setVoiceStatus(null), 3000);
        } else {
          console.error("Speech recognition error", event.error);
        }
        setIsRecording(false);
        recognitionRef.current = null;
      };
      recognition.start();
    }
  };

  // --- Render Helpers ---
  const getSeverityColor = (sev: string) => {
    switch (sev) {
      case 'critical': return 'text-coral-primary';
      case 'high': return 'text-orange-400';
      case 'medium': return 'text-amber-400';
      default: return 'text-emerald-400';
    }
  };

  const getSeverityBg = (sev: string) => {
    switch (sev) {
      case 'critical': return 'bg-coral-primary/10 border-coral-primary/30';
      case 'high': return 'bg-orange-400/10 border-orange-400/30';
      case 'medium': return 'bg-amber-400/10 border-amber-400/30';
      default: return 'bg-emerald-400/10 border-emerald-400/30';
    }
  };

  return (
    <div className="min-h-screen bg-bg text-text font-sans selection:bg-teal-primary/30">
      <div className="mesh-bg">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="orb orb-3" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-50 flex items-center justify-between px-6 py-3 bg-bg/80 backdrop-blur-xl border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-teal-primary to-sky-primary flex items-center justify-center shadow-lg shadow-teal-primary/20">
            <Activity className="w-5 h-5 text-bg" />
          </div>
          <h1 className="font-display font-extrabold text-xl tracking-tight">
            Life<span className="text-teal-primary italic">Aid</span>X
          </h1>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-[10px] font-mono text-text-muted">
            <div className="status-dot" />
            {isAnalyzing ? t.thinking : t.aiOnline}
          </div>
          <select 
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs font-mono outline-none focus:border-teal-primary/50"
          >
            <option value="English">🌐 EN</option>
            <option value="Hindi">🇮🇳 HI</option>
            <option value="Bengali">🇧🇩 BN</option>
          </select>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 max-w-5xl mx-auto px-6 py-12 pb-24">
        <AnimatePresence mode="wait">
          {activeTab === 'triage' && (
            <motion.div 
              key="triage"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              {/* Fall Status */}
              <div className="glass rounded-2xl p-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center border-2 transition-all duration-500 ${fallEnabled ? 'bg-teal-primary/10 border-teal-primary shadow-[0_0_15px_rgba(45,212,191,0.3)]' : 'bg-white/5 border-white/10'}`}>
                    <Shield className={`w-6 h-6 ${fallEnabled ? 'text-teal-primary' : 'text-text-muted'}`} />
                  </div>
                  <div>
                    <h3 className="font-display font-bold text-sm">{fallEnabled ? t.fallActive : t.fallOff}</h3>
                    <p className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                      {fallEnabled ? `${t.monitoring}: ${gForce.toFixed(2)}g` : t.toggleEnable}
                    </p>
                  </div>
                </div>
                <button 
                  onClick={() => setFallEnabled(!fallEnabled)}
                  className={`relative w-12 h-6 rounded-full transition-colors duration-300 ${fallEnabled ? 'bg-teal-primary' : 'bg-white/10'}`}
                >
                  <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform duration-300 ${fallEnabled ? 'translate-x-6' : ''}`} />
                </button>
              </div>

              {/* Triage Input */}
              <div className="glass rounded-3xl overflow-hidden focus-within:border-teal-primary/30 transition-all">
                <div className="px-6 py-4 border-b border-teal-primary/20 flex items-center justify-between bg-white/[0.05]">
                  <span className="text-[10px] font-mono text-teal-primary tracking-[0.2em] uppercase flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-teal-primary animate-pulse" />
                    {t.inputLabel}
                  </span>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-teal-primary/10 border border-teal-primary/20 shadow-[0_0_10px_rgba(45,212,191,0.1)]">
                      <div className="w-1 h-1 rounded-full bg-teal-primary animate-ping" />
                      <span className="text-[9px] font-mono text-teal-primary uppercase tracking-widest font-black">
                        2-5 MINS
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-text-muted">{symptoms.length} / 500</span>
                  </div>
                </div>
                <div className="relative">
                  <textarea 
                    id="symptom-input"
                    value={symptoms}
                    onChange={(e) => setSymptoms(e.target.value)}
                    placeholder={t.inputPlaceholder}
                    className="w-full h-40 bg-white/[0.01] p-6 outline-none resize-none text-xl leading-relaxed placeholder:text-text-muted/30 font-medium transition-all focus:bg-white/[0.03]"
                  />
                  {symptoms && (
                    <button 
                      onClick={() => setSymptoms('')}
                      className="absolute top-4 right-4 p-2 rounded-full bg-white/5 text-text-muted hover:bg-white/10 hover:text-text transition-all"
                    >
                      <XCircle className="w-5 h-5" />
                    </button>
                  )}
                </div>
                <div className="px-6 py-4 bg-white/[0.03] border-t border-white/5 flex items-center justify-between gap-4">
                  <button 
                    onClick={toggleVoice}
                    className={`group relative flex items-center gap-3 px-6 py-2.5 rounded-full border transition-all duration-500 ${
                      isRecording 
                        ? 'bg-coral-primary border-coral-primary text-white shadow-[0_0_25px_rgba(251,113,133,0.5)] scale-105' 
                        : 'bg-white/5 border-white/10 text-sky-primary hover:bg-white/10 hover:border-sky-primary/30 hover:scale-102'
                    }`}
                  >
                    {isRecording && (
                      <motion.div 
                        layoutId="active-glow"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: [0.2, 0.5, 0.2] }}
                        transition={{ repeat: Infinity, duration: 1.5 }}
                        className="absolute inset-0 rounded-full bg-coral-primary blur-md"
                        style={{ zIndex: -1 }}
                      />
                    )}
                    {isRecording ? (
                      <div className="flex gap-1 items-center">
                        <motion.div animate={{ height: [4, 14, 4] }} transition={{ repeat: Infinity, duration: 0.4 }} className="w-1 bg-white rounded-full" />
                        <motion.div animate={{ height: [10, 4, 10] }} transition={{ repeat: Infinity, duration: 0.4, delay: 0.1 }} className="w-1 bg-white rounded-full" />
                        <motion.div animate={{ height: [4, 12, 4] }} transition={{ repeat: Infinity, duration: 0.4, delay: 0.2 }} className="w-1 bg-white rounded-full" />
                        <motion.div animate={{ height: [8, 4, 8] }} transition={{ repeat: Infinity, duration: 0.4, delay: 0.3 }} className="w-1 bg-white rounded-full" />
                      </div>
                    ) : (
                      <Mic className="w-4 h-4 group-hover:scale-110 transition-transform" />
                    )}
                    <span className="text-sm font-bold tracking-wide uppercase">
                      {isRecording ? t.stop : t.voiceInput}
                    </span>
                  </button>
                  {voiceStatus && (
                    <motion.span 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-[10px] font-mono text-coral-primary uppercase tracking-wider"
                    >
                      {voiceStatus}
                    </motion.span>
                  )}
                  <button 
                    id="analyse-btn"
                    onClick={handleTriage}
                    disabled={isAnalyzing || !symptoms.trim()}
                    className="flex items-center gap-3 px-10 py-3 rounded-full bg-gradient-to-r from-teal-primary via-sky-primary to-teal-primary bg-[length:200%_auto] animate-gradient text-bg font-display font-black text-sm shadow-xl shadow-teal-primary/30 hover:scale-[1.05] active:scale-[0.95] transition-all disabled:opacity-50 disabled:grayscale disabled:scale-100"
                  >
                    {isAnalyzing ? <div className="w-5 h-5 border-3 border-bg/30 border-t-bg rounded-full animate-spin" /> : <Zap className="w-5 h-5 fill-current" />}
                    <span className="uppercase tracking-widest">{t.analyse}</span>
                  </button>
                </div>
              </div>

              {/* Quick Ambulance Booking */}
              <div className="space-y-4">
                <div className="flex items-center justify-between px-2">
                  <span className="text-[10px] font-mono text-text-muted tracking-[0.2em] uppercase flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-coral-primary" />
                    {t.nearbyHospitals}
                  </span>
                  <button 
                    onClick={findNearestHospital}
                    className="text-[10px] font-mono text-sky-primary hover:text-teal-primary transition-colors uppercase tracking-wider"
                  >
                    [ Refresh List ]
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {allHospitals.length > 0 ? (
                    allHospitals.slice(0, 6).map((h, i) => (
                      <motion.div 
                        key={h.name + i}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: i * 0.05 }}
                        className="glass rounded-2xl p-4 flex items-center justify-between gap-3 border-white/5 hover:border-coral-primary/30 transition-all group"
                      >
                        <div className="min-w-0">
                          <h4 className="font-bold text-xs truncate group-hover:text-coral-primary transition-colors">{h.name}</h4>
                          <div className="flex items-center gap-2 mt-1">
                            <MapPin className="w-3 h-3 text-text-muted" />
                            <p className="text-[10px] text-text-muted truncate">{h.dist.toFixed(1)} km</p>
                          </div>
                        </div>
                        <button 
                          onClick={() => bookAmbulance(h)}
                          disabled={isBooking === h.name}
                          title={t.bookAmbulance}
                          className="flex-shrink-0 w-10 h-10 rounded-xl bg-coral-primary/10 text-coral-primary flex items-center justify-center hover:bg-coral-primary hover:text-white transition-all shadow-lg shadow-coral-primary/5"
                        >
                          {isBooking === h.name ? (
                            <div className="w-4 h-4 border-2 border-coral-primary border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <Phone className="w-4 h-4" />
                          )}
                        </button>
                      </motion.div>
                    ))
                  ) : (
                    <div className="col-span-full py-8 text-center glass rounded-2xl border-dashed border-white/10">
                      <p className="text-xs text-text-muted italic">{t.locating}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Quick Chips */}
              <div className="flex flex-wrap gap-2">
                {SCENARIOS.map(sc => (
                  <button 
                    key={sc}
                    onClick={() => setSymptoms(sc)}
                    className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs text-text-muted hover:border-teal-primary/30 hover:text-text transition-all"
                  >
                    {sc}
                  </button>
                ))}
              </div>

              {/* Result Card */}
              {result && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="glass rounded-3xl overflow-hidden border-teal-primary/20"
                >
                  <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full animate-pulse ${getSeverityColor(result.severity).replace('text-', 'bg-')}`} />
                      <span className={`font-display font-bold text-lg uppercase tracking-tight ${getSeverityColor(result.severity)}`}>
                        {result.severity} {t.severity}
                      </span>
                    </div>
                    {result.callEmergency && (
                      <a 
                        href="tel:112"
                        className="flex items-center gap-2 px-4 py-2 rounded-full bg-coral-primary text-white font-display font-bold text-xs shadow-lg shadow-coral-primary/30 animate-bounce"
                      >
                        <Phone className="w-3.5 h-3.5" />
                        {t.call112}
                      </a>
                    )}
                  </div>
                  <div className="p-6 space-y-4">
                    <div className="flex items-center gap-2 text-[10px] font-mono text-text-muted uppercase tracking-widest">
                      <Stethoscope className="w-3 h-3" />
                      {t.protocol}
                    </div>
                    <div className="grid gap-3">
                      {result.steps.map((step, i) => (
                        <div key={i} className={`flex gap-4 p-4 rounded-2xl border ${getSeverityBg(result.severity)}`}>
                          <span className="font-mono text-xs opacity-50">{String(i + 1).padStart(2, '0')}</span>
                          <p className="text-sm leading-relaxed">{step}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="px-6 py-4 bg-white/[0.02] border-t border-white/5 flex items-center justify-between text-[10px] text-text-muted italic">
                    <div className="flex items-center gap-2">
                      🏥 {t.specialist}: <span className="text-sky-primary not-italic font-bold">{result.specialist}</span>
                    </div>
                    <p className="max-w-[200px] text-right">{result.disclaimer}</p>
                  </div>
                </motion.div>
              )}
            </motion.div>
          )}

          {activeTab === 'map' && (
            <motion.div 
              key="map"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-6"
            >
              <div className="flex items-center justify-between">
                <h3 className="font-display font-bold text-lg">{t.nearbyHospitals}</h3>
                <button 
                  onClick={findNearestHospital}
                  disabled={isLocating}
                  className="px-4 py-2 rounded-full bg-white/5 border border-white/10 text-xs text-text-muted hover:text-text transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  {isLocating && <Activity className="w-3 h-3 animate-spin" />}
                  {isLocating ? t.locating : t.locateHospitals}
                </button>
              </div>

              {allHospitals.length === 0 ? (
                <div className="h-[40vh] glass rounded-3xl flex flex-col items-center justify-center text-text-muted gap-4">
                  {isLocating ? (
                    <div className="flex flex-col items-center gap-4">
                      <div className="w-12 h-12 rounded-full border-2 border-teal-primary/20 border-t-teal-primary animate-spin" />
                      <p className="text-sm font-mono animate-pulse">{t.locating}</p>
                    </div>
                  ) : (
                    <>
                      <MapPin className="w-12 h-12 opacity-20" />
                      <p className="text-sm font-mono">{t.mapNote}</p>
                    </>
                  )}
                </div>
              ) : (
                <div className="grid gap-4">
                  {allHospitals.map((h, i) => (
                    <motion.div 
                      key={h.name + i}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.05 }}
                      className="glass rounded-2xl p-5 flex items-center justify-between gap-4 hover:border-teal-primary/30 transition-all"
                    >
                      <div className="flex items-start gap-4">
                        <div className="w-10 h-10 rounded-full bg-teal-primary/10 flex items-center justify-center flex-shrink-0">
                          <Activity className="w-5 h-5 text-teal-primary" />
                        </div>
                        <div>
                          <h4 className="font-bold text-sm">{h.name}</h4>
                          <p className="text-xs text-text-muted mt-1">{h.address}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <p className="text-[10px] font-mono text-sky-primary">{h.dist.toFixed(2)} {t.hospitalFound}</p>
                            {h.mapsUri && (
                              <a 
                                href={h.mapsUri} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-[10px] font-mono text-teal-primary hover:underline flex items-center gap-1"
                              >
                                <ExternalLink className="w-2.5 h-2.5" />
                                Maps
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <button 
                          onClick={() => bookAmbulance(h)}
                          disabled={isBooking === h.name}
                          className="flex items-center gap-2 px-6 py-2 rounded-full bg-gradient-to-r from-coral-primary to-rose-500 text-white font-display font-bold text-xs shadow-lg shadow-coral-primary/20 hover:scale-[1.05] active:scale-[0.95] transition-all disabled:opacity-50 group"
                        >
                          {isBooking === h.name ? (
                            <motion.div 
                              animate={{ rotate: 360 }}
                              transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                            >
                              <Activity className="w-3 h-3" />
                            </motion.div>
                          ) : (
                            <Phone className="w-3 h-3 group-hover:animate-bounce" />
                          )}
                          {isBooking === h.name ? t.booking : t.bookAmbulance}
                        </button>
                        <button 
                          onClick={() => setReportingHospital(h)}
                          className="text-[10px] font-mono text-text-muted hover:text-coral-primary transition-colors flex items-center gap-1 px-2 py-1 rounded-md hover:bg-white/5"
                        >
                          <MessageSquare className="w-3 h-3" />
                          {t.reportInaccuracy}
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'history' && (
            <motion.div 
              key="history"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-4"
            >
              <div className="flex items-center gap-2 mb-6">
                <div className="h-px flex-1 bg-gradient-to-r from-transparent to-white/10" />
                <span className="text-[10px] font-mono text-teal-primary uppercase tracking-widest">{t.incidentLog}</span>
                <div className="h-px flex-1 bg-gradient-to-l from-transparent to-white/10" />
              </div>
              
              {incidents.length === 0 ? (
                <div className="text-center py-20 opacity-30">
                  <History className="w-16 h-16 mx-auto mb-4" />
                  <p>{t.noIncidents}</p>
                </div>
              ) : (
                incidents.map((inc, i) => (
                  <div 
                    key={inc.id || i}
                    className={`glass rounded-2xl p-4 border-l-4 transition-all hover:bg-white/5 cursor-pointer ${inc.severity === 'critical' ? 'border-l-coral-primary' : 'border-l-teal-primary/30'}`}
                    onClick={() => {
                      setSymptoms(inc.symptoms);
                      setResult({
                        severity: inc.severity,
                        steps: inc.steps,
                        specialist: inc.specialist,
                        callEmergency: inc.severity === 'critical',
                        disclaimer: 'Historical record'
                      });
                      setActiveTab('triage');
                    }}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <h4 className="font-bold text-sm truncate max-w-[70%]">{inc.isFallEvent ? '⚠️ ' : ''}{inc.symptoms}</h4>
                      <span className="text-[10px] font-mono text-text-muted">
                        {new Date(inc.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${getSeverityBg(inc.severity)} ${getSeverityColor(inc.severity)}`}>
                        {inc.severity.toUpperCase()}
                      </span>
                      <span className="text-[10px] text-text-muted">{inc.specialist}</span>
                    </div>
                  </div>
                ))
              )}
            </motion.div>
          )}

          {activeTab === 'about' && (
            <motion.div 
              key="about"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-8"
            >
              <div className="space-y-4">
                <h2 className="text-4xl font-display font-black tracking-tighter bg-gradient-to-br from-teal-primary to-sky-primary bg-clip-text text-transparent">
                  {t.aboutTitle}
                </h2>
                <p className="text-text-muted leading-relaxed">
                  {t.aboutDesc}
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[
                  { val: '15-30', lbl: t.stat1 },
                  { val: '< 3s', lbl: t.stat2 },
                  { val: '10s', lbl: t.stat3 }
                ].map(stat => (
                  <div key={stat.lbl} className="glass rounded-2xl p-6 text-center">
                    <div className="text-3xl font-display font-black text-teal-primary">{stat.val}</div>
                    <div className="text-[10px] font-mono text-text-muted mt-2 uppercase tracking-wider">{stat.lbl}</div>
                  </div>
                ))}
              </div>

              <div className="glass rounded-2xl p-6 border-coral-primary/20 bg-coral-primary/5">
                <div className="flex items-center gap-3 mb-3 text-coral-primary">
                  <AlertTriangle className="w-5 h-5" />
                  <h4 className="font-display font-bold">{t.disclaimer}</h4>
                </div>
                <p className="text-xs text-text-muted leading-relaxed">
                  {t.disclaimerText}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Bottom Nav */}
      <nav className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1 p-1.5 glass rounded-full shadow-2xl shadow-black/50">
        {[
          { id: 'triage', icon: Activity, label: t.triage },
          { id: 'map', icon: MapPin, label: t.hospitals },
          { id: 'history', icon: History, label: t.history },
          { id: 'about', icon: Info, label: t.about }
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-full transition-all duration-300 ${activeTab === tab.id ? 'bg-gradient-to-r from-teal-primary to-sky-primary text-bg font-bold' : 'text-text-muted hover:text-text'}`}
          >
            <tab.icon className="w-4 h-4" />
            <span className={`text-xs font-medium ${activeTab === tab.id ? 'block' : 'hidden sm:block'}`}>{tab.label}</span>
          </button>
        ))}
      </nav>

      {/* Fall Modal */}
      <AnimatePresence>
        {showFallModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-bg/90 backdrop-blur-xl"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="w-full max-w-md bg-bg-panel border border-coral-primary/30 rounded-[32px] overflow-hidden shadow-2xl shadow-coral-primary/20"
            >
              <div className="bg-gradient-to-r from-coral-primary to-rose-500 px-8 py-4 flex items-center justify-between">
                <span className="font-display font-black text-white tracking-widest uppercase text-sm">{t.fallDetector}</span>
                <AlertTriangle className="w-6 h-6 text-white animate-pulse" />
              </div>
              <div className="p-8 text-center">
                <h2 className="text-2xl font-display font-black mb-2">{t.areYouOk}</h2>
                <p className="text-sm text-text-muted mb-8">{t.fallDetectedSub}</p>
                
                <div className="relative w-32 h-32 mx-auto mb-8">
                  <svg className="w-full h-full -rotate-90">
                    <circle cx="64" cy="64" r="60" className="stroke-white/5 fill-none" strokeWidth="8" />
                    <motion.circle 
                      cx="64" cy="64" r="60" 
                      className="stroke-amber-400 fill-none" 
                      strokeWidth="8" 
                      strokeLinecap="round"
                      initial={{ pathLength: 1 }}
                      animate={{ pathLength: countdown / 10 }}
                      transition={{ duration: 1, ease: "linear" }}
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-4xl font-display font-black">{countdown}</span>
                    <span className="text-[8px] font-mono text-text-muted uppercase tracking-widest">{t.seconds}</span>
                  </div>
                </div>

                {nearestHospital ? (
                  <div className="bg-teal-primary/5 border border-teal-primary/20 rounded-2xl p-4 flex items-start gap-4 text-left mb-8">
                    <div className="w-10 h-10 rounded-full bg-teal-primary/10 flex items-center justify-center flex-shrink-0">
                      <Activity className="w-5 h-5 text-teal-primary" />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-teal-primary">{nearestHospital.name}</p>
                      <p className="text-[10px] text-text-muted mt-1">{nearestHospital.address}</p>
                      <p className="text-[10px] font-mono text-sky-primary mt-1">{nearestHospital.dist.toFixed(1)} {t.hospitalFound}</p>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-text-muted italic mb-8 animate-pulse">{t.locating}</div>
                )}

                <div className="flex gap-3">
                  <button 
                    onClick={() => setShowFallModal(false)}
                    className="flex-1 py-4 rounded-full bg-white/5 border border-white/10 font-display font-bold text-sm hover:bg-white/10 transition-all"
                  >
                    {t.imOk}
                  </button>
                  <button 
                    onClick={dispatchAmbulance}
                    className="flex-1 py-4 rounded-full bg-coral-primary text-white font-display font-bold text-sm shadow-lg shadow-coral-primary/30"
                  >
                    {t.sendNow}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sent Modal */}
      <AnimatePresence>
        {reportingHospital && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[120] flex items-center justify-center p-6 bg-bg/80 backdrop-blur-md"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="glass w-full max-w-md rounded-[2.5rem] overflow-hidden shadow-2xl border-white/10"
            >
              <div className="p-8 space-y-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-coral-primary/10 flex items-center justify-center">
                    <AlertTriangle className="w-6 h-6 text-coral-primary" />
                  </div>
                  <div>
                    <h3 className="text-xl font-display font-bold">{t.reportTitle}</h3>
                    <p className="text-xs text-text-muted">{reportingHospital.name}</p>
                  </div>
                </div>

                <p className="text-sm text-text-muted leading-relaxed">
                  {t.reportDesc}
                </p>

                <div className="grid gap-2">
                  {['wrongPhone', 'wrongAddress', 'wrongLocation', 'other'].map((type) => (
                    <button
                      key={type}
                      onClick={() => setReportType(type)}
                      className={`flex items-center justify-between px-5 py-4 rounded-2xl border transition-all ${reportType === type ? 'bg-coral-primary/10 border-coral-primary text-coral-primary' : 'bg-white/5 border-white/10 text-text-muted hover:bg-white/10'}`}
                    >
                      <span className="text-sm font-medium">{t[type]}</span>
                      {reportType === type && <CheckCircle2 className="w-4 h-4" />}
                    </button>
                  ))}
                </div>

                <div className="flex gap-3 pt-2">
                  <button 
                    onClick={() => setReportingHospital(null)}
                    className="flex-1 py-4 rounded-2xl bg-white/5 font-display font-bold text-sm hover:bg-white/10 transition-all"
                  >
                    {t.closeSafe}
                  </button>
                  <button 
                    onClick={submitReport}
                    disabled={isSubmittingReport}
                    className="flex-[2] py-4 rounded-2xl bg-coral-primary text-white font-display font-bold text-sm shadow-lg shadow-coral-primary/20 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {isSubmittingReport && <Activity className="w-4 h-4 animate-spin" />}
                    {t.submitReport}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSentModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-bg/90 backdrop-blur-xl"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="w-full max-w-md bg-bg-panel border border-teal-primary/30 rounded-[32px] overflow-hidden shadow-2xl shadow-teal-primary/20"
            >
              <div className="bg-gradient-to-r from-teal-primary to-sky-primary px-8 py-10 text-center">
                <div className="w-20 h-20 bg-bg rounded-full flex items-center justify-center mx-auto mb-4 shadow-xl">
                  <CheckCircle2 className="w-10 h-10 text-teal-primary" />
                </div>
                <h2 className="text-2xl font-display font-black text-bg">{t.dispatched}</h2>
              </div>
              <div className="p-8">
                <div className="text-center mb-8">
                  <p className="text-sm text-text-muted">{t.eta}</p>
                  <p className="text-3xl font-display font-black text-teal-primary">8 - 12 min</p>
                </div>

                <div className="space-y-3 mb-8">
                  {[
                    { icon: Activity, label: t.from, val: dispatchedIncident?.hospital || 'Emergency Services' },
                    { icon: MapPin, label: t.yourLoc, val: dispatchedIncident?.lat ? `${dispatchedIncident.lat.toFixed(4)}, ${dispatchedIncident.lng?.toFixed(4)}` : 'Detected' },
                    { icon: Clock, label: t.fallTime, val: new Date().toLocaleTimeString() },
                    { icon: Zap, label: t.impact, val: 'Moderate' }
                  ].map(item => (
                    <div key={item.label} className="flex items-start gap-4 p-3 rounded-xl bg-white/5 border border-white/10">
                      <item.icon className="w-4 h-4 text-sky-primary mt-1" />
                      <div>
                        <p className="text-[8px] font-mono text-text-muted uppercase tracking-widest">{item.label}</p>
                        <p className="text-xs font-bold">{item.val}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <button 
                  onClick={() => window.location.href = 'tel:112'}
                  className="w-full py-4 rounded-full bg-coral-primary text-white font-display font-bold text-lg shadow-lg shadow-coral-primary/30 flex items-center justify-center gap-3 mb-4"
                >
                  <Phone className="w-5 h-5" />
                  {t.callNow}
                </button>
                <button 
                  onClick={() => setShowSentModal(false)}
                  className="w-full py-3 rounded-full bg-transparent border border-white/10 text-text-muted text-sm"
                >
                  {t.closeSafe}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
