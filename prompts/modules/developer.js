/**
 * Developer tab functionality - Backend tests
 */

import { log } from "../../agent/modules/utils.js";

/**
 * Run KB refinement test with fake data
 */
export async function runKbRefineTest() {
    const btn = document.getElementById("test-kb-refine");
    const outputDiv = document.getElementById("test-kb-refine-output");
    const resultPre = document.getElementById("test-kb-refine-result");
    
    btn.disabled = true;
    btn.textContent = "Testing...";
    outputDiv.style.display = "block";
    resultPre.textContent = "Starting KB refinement test...\n\n";
    
    try {
        // Fake test data
        const fakeKb = `- User prefers dark mode
- User works at TechCorp as software engineer
- User's manager is Alice
- User has weekly standup on Mondays at 10am
- User prefers morning emails
- User likes concise summaries
- User's team uses Slack for communication
- User prefers video calls over phone calls
- User's project deadline is end of Q1
- User takes vacation in March
- Reminder: Due 2026/01/10, submit timesheet (expired)
- Reminder: Due 2026/01/28, review PR from Bob
- Reminder: Due 2026/02/01, team lunch`;

        const fakeChatHistory = `User: Can you check my emails?
Agent: I found 3 new emails in your inbox.
User: Great, any from Alice?
Agent: Yes, there's one from Alice about the quarterly review meeting.
User: Remind me to prepare slides for that meeting by Thursday.
Agent: I'll remember to remind you to prepare slides for the quarterly review by Thursday.`;

        const currentTime = new Date().toISOString();
        
        resultPre.textContent += `Test Config:\n`;
        resultPre.textContent += `- max_bullets: 10 (to trigger trim)\n`;
        resultPre.textContent += `- reminder_retention_days: 7\n\n`;
        resultPre.textContent += `Fake KB (${fakeKb.split('\n').length} entries):\n${fakeKb}\n\n`;
        resultPre.textContent += `Fake Chat History:\n${fakeChatHistory}\n\n`;
        resultPre.textContent += `Sending to backend...\n\n`;
        
        // Call backend
        const systemMsg = {
            role: "system",
            content: "system_prompt_kb_refine",
            current_user_kb_md: fakeKb,
            chat_history: fakeChatHistory,
            current_time: currentTime,
            reminder_retention_days: 7,
            max_bullets: 10,
        };
        
        const startTime = Date.now();
        
        // Use dev backend
        const devBackendUrl = "http://localhost:8787";
        const response = await fetch(`${devBackendUrl}/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-user-id": "test-user",
                "x-plan-id": "test-plan",
                "x-billing-period": "2026-01",
            },
            body: JSON.stringify({
                messages: [systemMsg],
            }),
        });
        
        const elapsed = Date.now() - startTime;
        
        if (!response.ok) {
            const errorText = await response.text();
            resultPre.textContent += `ERROR (${response.status}): ${errorText}\n`;
            return;
        }
        
        const result = await response.json();
        resultPre.textContent += `Response received in ${elapsed}ms\n\n`;
        
        if (result.error) {
            resultPre.textContent += `Backend Error: ${result.error}\n`;
            return;
        }
        
        // Parse assistant response
        try {
            const parsed = JSON.parse(result.assistant || "{}");
            const refinedKb = parsed.refined_kb || "(no refined_kb in response)";
            const entryCount = refinedKb.split('\n').filter(l => l.trim()).length;
            
            resultPre.textContent += `SUCCESS!\n\n`;
            resultPre.textContent += `Refined KB (${entryCount} entries):\n`;
            resultPre.textContent += `${"─".repeat(50)}\n`;
            resultPre.textContent += `${refinedKb}\n`;
            resultPre.textContent += `${"─".repeat(50)}\n\n`;
            
            if (result.token_usage) {
                resultPre.textContent += `Token Usage:\n`;
                resultPre.textContent += `- Input: ${result.token_usage.input_tokens}\n`;
                resultPre.textContent += `- Output: ${result.token_usage.output_tokens}\n`;
                resultPre.textContent += `- Total: ${result.token_usage.total_tokens}\n`;
            }
        } catch (e) {
            resultPre.textContent += `Failed to parse response: ${e}\n`;
            resultPre.textContent += `Raw assistant: ${result.assistant}\n`;
        }
        
    } catch (e) {
        resultPre.textContent += `\nTest failed: ${e.message}\n`;
        log(`[Test] KB refine test failed: ${e}`, "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "Test KB Refinement";
    }
}

/**
 * Clear test output
 */
export function clearTestOutput() {
    document.getElementById("test-kb-refine-output").style.display = "none";
    document.getElementById("test-kb-refine-result").textContent = "";
}

/**
 * Check if debug mode is enabled
 */
export async function checkDebugMode() {
    try {
        const result = await browser.storage.local.get("tabmail_debug_mode");
        return result.tabmail_debug_mode === true;
    } catch (e) {
        log(`[Prompts] Error checking debug mode: ${e}`, "warn");
        return false;
    }
}

/**
 * Setup developer tab visibility based on debug mode
 */
export async function setupDeveloperTab() {
    const isDebug = await checkDebugMode();
    const devTab = document.querySelector('.prompt-tab[data-prompt="developer"]');
    if (devTab) {
        devTab.style.display = isDebug ? "" : "none";
    }
    return isDebug;
}
