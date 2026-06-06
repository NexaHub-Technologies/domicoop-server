Here is a detailed, structured summary of the cooperative’s contribution allocation rules. You can use this layout for your official documentation, user guides, or system requirements.

---

## Cooperative Contribution Allocation Policy

The cooperative utilizes a **fixed-fee and capped allocation system** rather than a static percentage system. This ensures that essential cooperative pools (Shares and Social) receive consistent funding from every member, while personal wealth accumulation (Savings and Deposits) scales up with higher contributions.

### 1. The Allocation Components

* **SHARES:** A fixed monthly amount determined by simple majority agreement. This is standard across all membership tiers regardless of the total amount paid.
* **SOCIAL:** A fixed monthly deduction used to fund collective cooperative social welfare initiatives.
* **SAVINGS:** The primary flexible component for standard subscriptions, capped at a maximum monthly limit.
* **DEPOSIT:** An overflow account that holds any extra funds contributed beyond the standard maximum subscription ceiling.

---

### 2. Tiered Allocation Breakdown

The system automatically categorizes payments into three distinct financial bands:

| Category / Tier | Total Monthly Payment ($T$) | Shares Allocation | Social Allocation | Savings Allocation | Deposit Allocation |
| --- | --- | --- | --- | --- | --- |
| **Minimum Subscription** | $6,000$ | $4,000$ | $1,000$ | $1,000$ | $0$ |
| **Mid-Tier Subscription** | Between $6,001$ and $50,999$ | $4,000$ | $1,000$ | $T - 5,000$ | $0$ |
| **Maximum Standard** | $51,000$ | $4,000$ | $1,000$ | $46,000$ | $0$ |
| **High-Tier (Overflow)** | Greater than $51,000$ | $4,000$ | $1,000$ | $46,000$ (Capped) | $T - 51,000$ |

---

### 3. Dynamic Percentage Impact

Because the **Shares** and **Social** allocations are static ($5,000$ combined), their weight decreases as a member's total contribution grows.

* **At the Minimum ($6,000$):** Fixed fees consume **$83.34\%$** of the payment, leaving **$16.66\%$** for savings.
* **At the Standard Max ($51,000$):** Fixed fees drop to just **$9.80\%$** of the total payment, allowing Savings to capture **$90.20\%$** of the value.
* **At the Overflow Tier ($101,000$):** Fixed fees drop to an minor **$4.95\%$**, Savings represents **$45.54\%$**, and the extra Deposit represents **$49.50\%$**.

---

### 4. Mathematical Logic for System Automation

If you are hardcoding this logic into an application or spreadsheet, the backend distribution handles any incoming payment ($T$) using the following conditional rules:

#### **Rule A: If $T \le 51,000$**

* $$\text{Shares} = 4,000$$


* $$\text{Social} = 1,000$$


* $$\text{Savings} = T - 5,000$$


* $$\text{Deposit} = 0$$



#### **Rule B: If $T > 51,000$**

* $$\text{Shares} = 4,000$$


* $$\text{Social} = 1,000$$


* $$\text{Savings} = 46,000$$


* $$\text{Deposit} = T - 51,000$$
