package com.example.bookshop;

/** What every service does the same way. */
public abstract class BaseService {
    /** Whether this service may write at all. */
    public abstract boolean writable();
}
