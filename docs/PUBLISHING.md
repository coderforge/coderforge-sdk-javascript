# Public source and package releases

Gitea is the primary source repository. Its native push mirror automatically
propagates commits, branches and tags to `https://github.com/coderforge/coderforge-sdk-javascript`.
A merge into `master` therefore updates GitHub without a workstation push.
The mirror also retries on an eight-hour schedule. Maintain source changes
on Gitea; independent GitHub changes can be overwritten by the mirror.

The stable `v1.0.0` tag is immutable and MIT-licensed. Merging source does not
reuse an existing package version. Increment the package version and create
a new matching stable tag for a subsequent package release.

The public npm package is `@coderforge/cloud-sdk`, shared by
JavaScript and TypeScript. Version 1.0.0 is already published.
Git source mirroring does not upload a new npm package: registry
publication remains a separate, versioned release action.
