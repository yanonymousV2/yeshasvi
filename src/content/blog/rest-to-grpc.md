---
title: "From 2s to 400ms: moving service calls from REST to gRPC"
description: "Our microservices talked to each other over REST, and every hop added latency. Here's what changed when those calls moved to gRPC."
pubDate: 2026-10-21
tags: [grpc, microservices, performance]
draft: true
---

Our services talked to each other over REST, and one user request often meant a chain of calls between them. The latency added up: about **2 seconds** for the internal calls alone. Moving that service-to-service traffic to gRPC brought it down to around **400ms**.

## The problem

✍️ What did users or the team notice first? Slow pages, timeouts, a dashboard?

✍️ Roughly what did a typical request path look like? (e.g. "a request hit 4–5 services in sequence")

## Why REST was slow here

Each hop paid the same costs again:

- **Connection setup**, when clients weren't reusing connections
- **JSON** encoding and decoding on both sides of every call
- **HTTP/1.1** making parallel calls wait their turn on a connection

✍️ Which of these mattered most in your case, if you know?

## Why gRPC

- Persistent **HTTP/2** connections with many calls multiplexed over one
- **Protobuf**: smaller payloads, faster to encode and decode
- **One contract** that generates clients for both Go and Python

✍️ Did you consider alternatives, like tuning REST with keep-alive or merging services? Why gRPC instead?

A contract looks like this:

```protobuf
syntax = "proto3";

service Jobs {
  rpc Submit (JobRequest) returns (JobStatus);
}

message JobRequest {
  string payload_id = 1;
}

message JobStatus {
  string job_id = 1;
  string state = 2;
}
```

And calling it from Go is an ordinary function call:

```go
conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(creds))
if err != nil {
    return err
}
defer conn.Close()

client := pb.NewJobsClient(conn)
status, err := client.Submit(ctx, &pb.JobRequest{PayloadId: id})
```

## Rolling it out

✍️ Service by service, or all at once? Did you run REST and gRPC side by side for a while?

✍️ What broke, or surprised you?

## Results

- Service-to-service latency: **~2s → ~400ms**

✍️ Anything else you saw: CPU, memory, error rates, how it felt to work with?

## What I'd tell someone doing this next

✍️ Two or three lessons.

> Try the interactive version of this on the [homepage](../../#work): change the number of hops and payload size and watch the gap between REST and gRPC grow.
