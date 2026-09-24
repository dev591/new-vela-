# MediSense AI — Atlas

AI medical assistant for doctors. Upload patient reports, ask questions by voice, get instant answers.

## What's Inside

- GPT-4o Vision reads medical reports (blood tests, CBC, lab reports)

- Voice queries answered instantly using patient memory

- Medication safety check against drugs.com

- Auto medication recommendations per detected problem

- Report comparison and deterioration detection

- Real-time risk alerts via Socket.IO

- Shift handover report generation

- 3-agent CrewAI pipeline for complex queries

## Setup

### 1. Clone

```bash

git clone https://github.com/YOUR_USERNAME/medisense-ai.git

cd medisense-ai

```

### 2. Install

```bash

pip install -r requirements.txt

```

### 3. Create .env file

```

OPENAI_API_KEY=your_key

api_key=your_mem0_key

SUPABASE_URL=your_supabase_url

SUPABASE_ANON_KEY=your_supabase_anon_key

```

### 4. Run

```bash

uvicorn main:app --port 8001

```

### 5. Test

```bash

curl http://localhost:8001/health

```

## API Endpoints

| Method | Endpoint | What it does |

|---|---|---|

| GET | /api/patients/list | All patients sorted by risk |

| GET | /api/patients/emergency | Only risk > 70 patients |

| GET | /api/patients/:id | Patient + docs + meds + notes |

| POST | /api/patients/add | Add new patient |

| POST | /api/upload/document | Upload PDF → AI reads it |

| POST | /api/voice/query | Ask Atlas anything |

| POST | /api/voice/complex | Complex multi-patient analysis |

| POST | /api/medication/check | Check drug safety |

| POST | /api/recommendations/get | Get medication recommendations |

| POST | /api/reports/compare | Compare 2 reports |

| POST | /api/handover/generate | Generate handover report |

| POST | /api/notes/add | Add doctor note |

| POST | /api/reminders/add | Add reminder |

| PUT | /api/reminders/:id/done | Mark reminder done |

## Socket.IO Events

| Event | When |

|---|---|

| risk_alert | Report risk score > 70 |

| deterioration_alert | Patient worsening across reports |

| medication_warning | Dangerous drug interaction |

| recommendations_ready | Medication suggestions ready |

| document_ready | AI finished processing |

## Tech Stack

- FastAPI + Uvicorn

- OpenAI GPT-4o + GPT-4o Mini

- Mem0 patient memory

- CrewAI 3-agent pipeline

- Supabase (Postgres)

- Socket.IO real-time events

- drugs.com scraping (BeautifulSoup)

## Built in 18 days — MediSense AI Hackathon 2026

