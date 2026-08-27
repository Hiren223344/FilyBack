#!/usr/bin/env python3
"""
FilyBase Python SDK Verification & Smoke Test Script
Demonstrates exact drop-in replacement with the official openai Python SDK.
"""

import os
import sys
import json
import urllib.request
import urllib.error

BASE_URL = os.environ.get("GATEWAY_URL", "http://localhost:8080")
API_KEY = os.environ.get("FILYBASE_API_KEY", "sk-fb-live-demo-key-1234567890abcdef")

def run_standard_http_test():
    print(f"\n🐍 Running Python HTTP Smoke Test against: {BASE_URL}")
    
    # 1. Test Chat Completions (Non-Streaming)
    req_data = json.dumps({
        "model": "llama-3.3-70b",
        "messages": [
            {"role": "system", "content": "You are a helpful GPU inference assistant."},
            {"role": "user", "content": "What is 10 * 10?"}
        ],
        "temperature": 0.5,
        "max_tokens": 50
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{BASE_URL}/v1/chat/completions",
        data=req_data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req) as resp:
            print(f"  ✓ Chat status: {resp.status}")
            print(f"  ✓ Header x-filybase-request-id: {resp.headers.get('x-filybase-request-id')}")
            print(f"  ✓ Header x-filybase-latency-ms: {resp.headers.get('x-filybase-latency-ms')}")
            print(f"  ✓ Header x-filybase-credits-used: {resp.headers.get('x-filybase-credits-used')}")
            body = json.loads(resp.read().decode("utf-8"))
            content = body["choices"][0]["message"]["content"]
            print(f"  ✓ Assistant output: \"{content}\"")
            print(f"  ✓ Token usage: {body.get('usage')}")
    except urllib.error.HTTPError as e:
        print(f"  ✗ HTTP Error {e.code}: {e.read().decode('utf-8')}")
        sys.exit(1)

    # 2. Test Image Generation
    img_data = json.dumps({
        "model": "stable-diffusion-3.5",
        "prompt": "A modern cyberpunk metropolis in rain",
        "n": 1
    }).encode("utf-8")

    img_req = urllib.request.Request(
        f"{BASE_URL}/v1/images/generations",
        data=img_data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(img_req) as resp:
            print(f"\n  ✓ Image status: {resp.status}")
            body = json.loads(resp.read().decode("utf-8"))
            print(f"  ✓ Image URL: {body['data'][0]['url']}")
    except urllib.error.HTTPError as e:
        print(f"  ✗ Image error {e.code}: {e.read().decode('utf-8')}")
        sys.exit(1)

    print("\n🎉 Python HTTP smoke test completed successfully!")

def run_openai_sdk_test():
    try:
        import openai
    except ImportError:
        print("\nℹ️  Notice: 'openai' Python package is not installed. To test with OpenAI SDK, run: pip install openai")
        return

    print("\n📦 Testing with official Python `openai` SDK:")
    client = openai.OpenAI(
        base_url=f"{BASE_URL}/v1",
        api_key=API_KEY
    )

    # Non-streaming
    response = client.chat.completions.create(
        model="llama-3.3-70b",
        messages=[{"role": "user", "content": "Hello FilyBase from Python SDK!"}]
    )
    print(f"  ✓ SDK Response: {response.choices[0].message.content}")

    # Streaming
    print("  ✓ SDK Streaming: ", end="", flush=True)
    stream = client.chat.completions.create(
        model="llama-3.3-70b",
        messages=[{"role": "user", "content": "Count from 1 to 3."}],
        stream=True
    )
    for chunk in stream:
        delta = chunk.choices[0].delta.content or ""
        print(delta, end="", flush=True)
    print("\n")

if __name__ == "__main__":
    run_standard_http_test()
    run_openai_sdk_test()
