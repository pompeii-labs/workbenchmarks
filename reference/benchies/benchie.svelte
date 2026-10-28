<script lang="ts">
    import BenchCharacter from './benchcharacter.svelte';
    let { class: className = '' }: { class?: string } = $props();
</script>

<BenchCharacter
    shape="block"
    color="orange"
    prop="briefcase"
    mood="keen"
    seed={2}
    crop="tight"
    class={className}
/>
