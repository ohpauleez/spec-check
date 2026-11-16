Originally asked: How should properties of a specification be verified using ontologies through a process of autoformalization?  The specifications mix EARS format and Alloy modeling syntax in a markdown file.  The EARS syntax currently goes through an autoformalization process, getting turned into SMT-LIB code for Z3.

Approach:

To bridge **EARS-to-SMT** autoformalization with **Alloy relational models** and **ontologies**, you can use the ontology as a **semantic middle layer** or a **meta-schema** to unify your system's concepts before sending constraints to back-end solvers like [Z3](https://github.com/Z3Prover/z3) or [Alloy's Kodkod](https://alloytools.org/).

Because EARS (Easy Approach to Requirements Syntax) maps patterns (like *"While \<precondition\>, When \<trigger\>, the system shall \<action\>"*) into logical assertions, and Alloy defines relational signatures and facts, an ontology bridges them by standardizing your domain vocabulary. \[1, 2\]

## ---

**🏗️ Architectural Framework**

               \[ Markdown Source Specification \]  
                 /                           \\  
       (EARS Requirements)              (Alloy Relational Models)

                |                                    |  
     \[ Autoformalization LLM \]              \[ Relational Parser \]  
                \\                                    /  
                 v                                  v  
         \[ Web Ontology Language (OWL) / SHACL Semantic Layer \]

                 |                                    |  
                 v                                    v  
     \[ SMT-LIB v2 (Z3 Assertions) \]         \[ Alloy / Kodkod Relational SAT \]

## ---

**🛠️ 3 Methods to Integrate Ontologies**

## **1\. The Ontology as a Unified Vocabulary (TBox)**

Instead of letting the autoformalizer generate arbitrary SMT-LIB constants, use an Web Ontology Language (OWL) ontology as your **Terminological Box (TBox)**.

> *   
> * **The Process**: Your markdown file lists definitions. The autoformalizer parses EARS and Alloy, mapping every subject, predicate, and object to an OWL Class, ObjectProperty, or DataProperty.  
> * **The Output**: Your pipeline auto-generates SMT-LIB sorts and functions directly derived from the ontology hierarchy. \[3\]  
> * 

## **2\. Dual-Engine Verification (Ontology \+ Solver)**

Use Web Ontology Language (OWL) reasoners and SMT solvers for what they each do best.

> *   
> * **Structural Consistency (OWL / Open-World)**: Use a reasoner like [HermiT](http://www.hermit-reasoner.com/) or [Pellet](https://github.com/stardog-union/pellet) on your ontology to catch structural paradoxes (e.g., a component classified under two disjoint classes, or an EARS trigger referencing an impossible state).  
> * **Behavioral Verification (SMT & Alloy / Closed-World)**: Feed the structured ontology facts (ABox) along with your autoformalized SMT-LIB code into Z3 to find specific counterexamples over time-series traces or state changes.  
> * 

## **3\. SHACL for Syntactic and Semantic Markdown Validation**

Since you are mixing EARS and Alloy inside Markdown, you can translate the parsed AST of your document into RDF graphs and validate it using [SHACL (Shapes Constraint Language)](https://www.w3.org/TR/shacl/).

> *   
> * **The Rule**: Ensure that any variable used in an EARS requirement statement is explicitly declared in an Alloy sig block elsewhere in that same Markdown file.  
> * 

## ---

**📝 Example: Unified Mapping Workflow**

Suppose your Markdown file has this mixed definition:

\# Component: Power Subsystem  
\`\`\`alloy  
sig Battery { level: Int }  
\`\`\`  
\# Requirement: Low Power State  
While the battery level is critical, when a timer interrupt occurs, the system shall enter SleepMode.

An ontology-driven autoformalization pipeline handles this by mapping both styles to an RDF triple graph before emitting SMT-LIB code:

$$\\text{Battery} \\sqsubseteq \\text{Component}$$  
$$\\text{SleepMode} \\sqsubseteq \\text{SystemState}$$

## **Generated SMT-LIB v2 Template Guided by the Ontology**

; Sort declarations dictated by OWL classes  
(declare-sort Component 0\)  
(declare-sort SystemState 0\)

; Relations guided by Alloy signatures and OWL properties  
(declare-fun battery\_level (Component) Int)  
(declare-fun current\_state () SystemState)

; EARS Autoformalized requirement constraint  
(assert (forall ((b Component))  
  (implies   
    (and (\< (battery\_level b) 10\) timer\_interrupt) ; While / When  
    (= current\_state SleepMode)                   ; Then System Shall  
  )  
))

## ---

**🚀 Recommended Pipeline Setup**

> 1. **Markdown AST Parsing**: Use a parser like [Markdig](https://github.com/xoofx/markdig) or [Python-Markdown](https://python-markdown.github.io/) to extract the text blocks, separating EARS strings from Alloy code blocks.  
> 2. **Knowledge Graph Generation**: Map your Alloy sig fields to an [RDFLib](https://rdflib.readthedocs.io/) in-memory graph.  
> 3. **Context-Aware SMT Generation**: Pass the RDF graph schema context into your SMT-LIB autoformalization script. This ensures the generated Z3 variables match your relational Alloy definitions exactly.

---

To help refine this autoformalization workflow, could you clarify:

> *   
> * Do your EARS requirements primarily describe **state transitions / temporal behaviors**, or are they **static structural constraints**?  
> * Are you looking to generate the **OWL ontology automatically** from the markdown, or do you want an **existing ontology** to guide and constrain the autoformalization process?  
> * 

\[1\] [https://www.sciencedirect.com](https://www.sciencedirect.com/science/article/pii/S0166361523001240)  
\[2\] [https://dev.to](https://dev.to/sebastian_dingler/ears-the-easy-approach-to-requirements-syntax-39a5)  
\[3\] [https://ksiresearch.org](https://ksiresearch.org/seke/seke22paper/paper179.pdf)