from crewai import Agent, Task, Crew, LLM
from mem0 import MemoryClient
from dotenv import load_dotenv
import os

load_dotenv()

mem0_client = MemoryClient(api_key=os.getenv("api_key"))

# Use OpenAI via CrewAI's LLM wrapper
llm = LLM(
    model="gpt-4o-mini",
    api_key=os.getenv("OPENAI_API_KEY")
)

def fetch_patient_memories(patient_id: str) -> str:
    results = mem0_client.search(
        query="patient health summary critical values risk",
        user_id=patient_id,
        filters={"user_id": patient_id}
    )
    memories = [r["memory"] for r in results["results"]]
    return "\n".join(memories) if memories else "No data found."

def run_crew_analysis(question: str, patient_ids: list) -> str:
    # Fetch all patient data
    all_patient_data = ""
    for pid in patient_ids:
        data = fetch_patient_memories(pid)
        all_patient_data += f"\n--- {pid} ---\n{data}\n"

    # Agent 1 — Reader: finds relevant data
    reader = Agent(
        role="Medical Data Reader",
        goal="Find and extract the most relevant patient data for the doctor's question",
        backstory="You are an expert at reading medical records and finding exactly what the doctor needs.",
        llm=llm,
        verbose=False
    )

    # Agent 2 — Analyst: interprets the data
    analyst = Agent(
        role="Medical Analyst",
        goal="Analyze patient data, identify critical patterns and risks",
        backstory="You are a senior medical analyst who identifies critical values, patterns, and risks across patient data.",
        llm=llm,
        verbose=False
    )

    # Agent 3 — Responder: forms the final answer
    responder = Agent(
        role="Atlas Medical Responder",
        goal="Give a clear, concise, actionable answer to the doctor",
        backstory="You are Atlas, an AI medical assistant. You give direct, clear answers that help doctors make decisions fast.",
        llm=llm,
        verbose=False
    )

    # Tasks
    task1 = Task(
        description=f"""From this patient data, extract what is relevant to answer: '{question}'
        
Patient data:
{all_patient_data}""",
        expected_output="Relevant patient data and facts extracted from records",
        agent=reader
    )

    task2 = Task(
        description=f"Analyze the extracted data. Identify critical values, risks, and patterns relevant to: '{question}'",
        expected_output="Medical analysis with critical flags and risk assessment",
        agent=analyst,
        context=[task1]
    )

    task3 = Task(
        description=f"Give a final clear answer to the doctor's question: '{question}'. Max 4 sentences. Flag anything critical.",
        expected_output="Clear, direct medical answer for the doctor",
        agent=responder,
        context=[task1, task2]
    )

    crew = Crew(
        agents=[reader, analyst, responder],
        tasks=[task1, task2, task3],
        verbose=False
    )

    result = crew.kickoff()
    return str(result)


# NOTE: This block was used for prototype development.
# Do NOT run this directly — it seeds a hardcoded patient_id into Mem0 which
# can pollute live patient context retrieval in production.
# To test, invoke /api/voice/query via the live API instead.
if __name__ == "__main__":
    print("🤖 CrewAI crew_agents.py loaded. Run via the API, not directly.")